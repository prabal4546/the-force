// Gesture maths for the band module. Pure functions and one small state machine:
// no band, no page, no timers. Time comes from each sample's own `t` (milliseconds).

// Every threshold in one place.
export const CONFIG = {
  motionRate: 100,          // samples a second asked from the band
  motionFallbackRate: 50,   // used instead once the link reports dropped stream data

  // Calibration
  poseMs: 2000,             // how long each calibration pose is recorded
  minPoseDps: 20,           // a twist or flick pose must move at least this much (RMS, deg/s)
  holdMaxDps: 30,           // a hold-still pose must move less than this (RMS, deg/s)
  swingSignDps: 60,         // first swing above this decides which way is "clockwise" / "right"

  // Clutch: twist and flick only count near the level pose
  clutchDegrees: 50,
  clutchIgnoresTwist: true, // true: compare forearm elevation only, so turning the wrist does not
                            //       open the clutch. false: plain angle between gravity directions.
  gravitySmoothing: 0.1,    // 0..1, share of each new sample in the gravity estimate
  upSmoothing: 0.03,        // the same for "which way is up", slower so a flick does not disturb it
  sidewaysShare: 0.5,       // a calibrated flick must be at least this much sideways (not up and down)

  // Wrist angle (roll about the forearm): the gyro for speed, gravity to stop it drifting
  rollBlend: 0.02,          // share of the gravity reading pulled into the angle on each sample
  stillDps: 25,             // below this on both axes the wrist counts as resting
  stillMs: 300,             // resting this long makes the current angle the new zero

  // Twist: turn away from the resting angle to adjust; turning back is free
  twistMinDps: 30,          // a twist only starts while turning at least this fast
  twistStepDegrees: 15,     // one adjust message per this many degrees turned away
  adjustStep: 0.05,         // the delta in each adjust message
  neutralDegrees: 10,       // back within this of the resting angle, the twist is over
  twistEndMs: 300,          // ... or after this long without turning
  returnMs: 1500,           // after a twist, this long to turn back for free

  // Flick: a short sideways spike (turning about the vertical, whichever way the wrist is
  // rolled) that is stronger than the twist axis
  flickMinDps: 250,         // the spike must exceed this ...
  flickPeakShare: 0.5,      // ... or this share of the wearer's calibrated flick, if that is less
  flickFloorDps: 150,       // but never less than this
  flickMaxMs: 300,          // and must be shorter than this (above the threshold)
  flickDominance: 1.3,      // flick axis at least this many times the twist axis ("twist-free")
  peakMemoryMs: 120,        // how long a peak is remembered when comparing the two axes

  // Taps
  tapBeforeDoubleTap: true, // the band sends a tap before a double-tap: hold toggle back.
                            // Checked on the real band: after tapCheckCount double-taps with no tap
                            // before any of them, the module sets this to false by itself.
  tapCheckCount: 3,
  tapDelayMs: 300,          // how long toggle waits for a double-tap to cancel it
  tapCheckMs: 600,          // a tap this close before a double-tap counts as "sent before it"

  // Voice: the microphone is on from connect, and a wake word starts a command
  micGainDb: 8,             // band microphone gain (default +20): low, so only a voice near the wrist registers
  wakeWords: ['vexo', 'vex oh', "vexo's", 'vecto', 'vexa', 'texaco'],   // what "Vexo" may come back as; case does not matter
  wakeTimeoutMs: 3000,      // nothing said this long after the wake word: forget it
  wakeIgnoreMs: 2000,       // a second wake word this soon after one is ignored
  wakeStallMs: 2500,        // words heard but never marked finished: send them after this long
  pushToTalkFlushMs: 1200,  // after the spacebar is released, wait this long for the last words

  // Speaking (ElevenLabs) and the light
  ttsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',   // the voice; any voice id from the ElevenLabs voice library
  ttsModel: 'eleven_flash_v2_5',        // the fast model: short device names come back in a fraction of a second
  errorBlinks: 3,           // red blinks for an error message
  errorBlinkMs: 180,        // each half of a blink

  // All gestures
  cooldownMs: 500,          // quiet time after each gesture
  flashMs: 120,             // white LED flash on each gesture
  flashGapMs: 300,          // at most one flash per this long (a twist sends many messages)
};

const GYRO = ['gx', 'gy', 'gz'];
const ACCEL = ['ax', 'ay', 'az'];
const DEG = 180 / Math.PI;

export function unit(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/** Angle between two directions, in degrees. */
export function angleBetween(a, b) {
  const [ua, ub] = [unit(a), unit(b)];
  const dot = ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
}

/** Average gravity direction of a recording, as a unit vector. */
export function meanGravity(samples) {
  const sum = [0, 0, 0];
  for (const s of samples) ACCEL.forEach((k, i) => { sum[i] += s[k]; });
  return unit(sum);
}

/** How much each gyro axis moved in a recording (RMS, deg/s). */
export function gyroEnergy(samples) {
  const energy = {};
  for (const axis of GYRO) {
    let sum = 0;
    for (const s of samples) sum += s[axis] * s[axis];
    energy[axis] = samples.length ? Math.sqrt(sum / samples.length) : 0;
  }
  return energy;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const wrap = (degrees) => ((degrees + 540) % 360) - 180;          // into -180..180
const NO_BIAS = { gx: 0, gy: 0, gz: 0 };

/** The gyro reading as a vector, without the sensor's resting offset. */
function gyro(sample, bias = NO_BIAS) {
  return [sample.gx - bias.gx, sample.gy - bias.gy, sample.gz - bias.gz];
}

/** Turning speed about one direction, deg/s. */
export function rateAbout(sample, axis, bias = NO_BIAS) {
  return dot(gyro(sample, bias), axis);
}

/**
 * The direction a recording turned about most, as a unit vector: the band rarely sits
 * square on the wrist, so a twist shows on all three gyro axes at once. `without` is a
 * direction to leave out first (the twist axis, when looking for the flick axis).
 */
export function mainAxis(samples, bias = NO_BIAS, without = null) {
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];     // how the three gyro axes vary together
  for (const s of samples) {
    let w = gyro(s, bias);
    if (without) { const along = dot(w, without); w = w.map((v, i) => v - along * without[i]); }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += w[i] * w[j];
  }
  const strongest = [0, 1, 2].reduce((best, i) => (c[i][i] > c[best][best] ? i : best));
  let axis = [0, 0, 0];
  axis[strongest] = 1;
  for (let n = 0; n < 40; n++) axis = unit(c.map((row) => dot(row, axis)));   // settles on the main direction
  return axis;
}

/** RMS turning speed about a direction over a recording, deg/s. */
function energyAbout(samples, axis, bias = NO_BIAS, without = null) {
  let sum = 0;
  for (const s of samples) {
    let w = gyro(s, bias);
    if (without) { const along = dot(w, without); w = w.map((v, i) => v - along * without[i]); }
    sum += dot(w, axis) ** 2;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * The vertical, as the band sees it, with any part along the forearm taken out: the axis a
 * sideways flick turns about. It follows gravity, so it is the same motion in the room
 * whether the palm faces down, the thumb is up, or anything between.
 */
export function sidewaysAxis(gravity, twistVec) {
  const along = dot(gravity, twistVec);
  return unit(gravity.map((v, i) => v - along * twistVec[i]));
}

/** Point the axis so that the first clear swing of the recording is positive. */
function firstSwingPositive(samples, axis, bias, threshold) {
  const first = samples.find((s) => Math.abs(rateAbout(s, axis, bias)) >= threshold);
  return first && rateAbout(first, axis, bias) < 0 ? axis.map((v) => -v) : axis;
}

const letter = (axis) => GYRO[[0, 1, 2].reduce((best, i) => (Math.abs(axis[i]) > Math.abs(axis[best]) ? i : best))];

/**
 * Is one recorded calibration pose usable? Returns null when it is, or a sentence saying
 * what to do differently. `kind` is 'level', 'twist' or 'flick'; `poses` holds the
 * recordings accepted so far ({ level, twist }).
 */
export function checkPose(kind, samples, poses = {}, config = CONFIG) {
  if (samples.length < 10) return 'No motion arrived from the band. Is it still connected?';
  const moved = energyAbout(samples, mainAxis(samples));
  if (kind === 'level') {
    return moved > config.holdMaxDps ? 'Your arm was moving. Hold it still for the whole 2 seconds.' : null;
  }
  if (moved < config.minPoseDps) {
    return kind === 'twist' ? 'That hardly moved. Turn your wrist like a doorknob, back and forth, the whole time.'
      : 'That hardly moved. Flick your hand side to side the whole time.';
  }
  if (kind === 'flick' && poses.twist) {
    const twistAxis = mainAxis(poses.twist);
    const all = energyAbout(samples, mainAxis(samples, NO_BIAS, twistAxis), NO_BIAS, twistAxis);
    if (all < config.minPoseDps) {
      return 'That looked like the twist again. Keep your forearm still and wave your hand left and right.';
    }
    const sideways = energyAbout(samples, sidewaysAxis(meanGravity(samples), twistAxis));
    if (sideways < config.minPoseDps || sideways < config.sidewaysShare * all) {
      return 'Your hand moved up and down more than sideways. Wave it left and right, level with the floor.';
    }
  }
  return null;
}

/**
 * Turn the three recorded poses into a calibration.
 * The twist axis is the direction the twist pose turned about; the flick axis is the main
 * direction of the flick pose once the twist direction is taken out, so the two never
 * overlap. The person starts the twist clockwise and the flick to the right: the first
 * swing of each recording fixes which way is positive.
 */
export function computeCalibration(level, twist, flick, config = CONFIG) {
  if (level.length < 10 || twist.length < 10 || flick.length < 10) {
    throw new Error('Too few motion samples were recorded. Is the band still connected?');
  }
  const gravity = meanGravity(level);
  const bias = {};                                 // what the gyro reads while the arm is still
  for (const axis of GYRO) bias[axis] = level.reduce((sum, s) => sum + s[axis], 0) / level.length;

  let twistVec = mainAxis(twist, bias);
  if (energyAbout(twist, twistVec, bias) < config.minPoseDps) {
    throw new Error('The twist pose hardly moved. Turn your wrist like a doorknob for the whole 2 seconds.');
  }
  twistVec = firstSwingPositive(twist, twistVec, bias, config.swingSignDps);
  let flickVec = mainAxis(flick, bias, twistVec);
  if (energyAbout(flick, flickVec, bias) < config.minPoseDps) {
    throw new Error('The flick pose hardly moved. Flick your hand side to side for the whole 2 seconds.');
  }
  // A flick is sideways in the room: turning about the vertical. Which sign is "right" comes
  // from the first swing of the recording.
  const side = sidewaysAxis(meanGravity(flick), twistVec);
  const sideways = energyAbout(flick, side, bias);
  if (sideways < config.minPoseDps || sideways < config.sidewaysShare * energyAbout(flick, flickVec, bias)) {
    throw new Error('The flick went up and down more than sideways. Wave your hand left and right, level with the floor.');
  }
  const first = flick.find((s) => Math.abs(rateAbout(s, side, bias)) >= config.swingSignDps);
  const flickSign = first && rateAbout(first, side, bias) < 0 ? -1 : 1;

  const calibration = { gravity, bias, twistVec, flickVec, flickSign, twistAxis: letter(twistVec), flickAxis: letter(flickVec) };
  calibration.rollSign = rollDirection(twist, calibration);
  calibration.flickPeak = percentile(flick.map((s) => Math.abs(rateAbout(s, side, bias))), 0.95);
  return calibration;
}

function percentile(values, share) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * Wrist roll about the forearm (twist) axis as gravity shows it, in degrees from the level
 * pose. Drift-free but shaky while the hand moves. Null when gravity lies along the forearm.
 */
export function gravityRoll(accel, calibration) {
  const t = calibration.twistVec, g = calibration.gravity;
  const along = dot(g, t);
  const p = unit(g.map((v, i) => v - along * t[i]));   // level gravity, seen across the forearm: roll 0
  const q = cross(t, p);
  const x = dot(accel, p), y = dot(accel, q);
  return Math.hypot(x, y) < 0.4 ? null : Math.atan2(y, x) * DEG;
}

/** +1 when turning clockwise makes gravityRoll grow, -1 when it makes it shrink. */
function rollDirection(twist, calibration) {
  let agreement = 0;
  const gap = 5;                                   // compare over 5 samples: steadier than one
  const rolls = twist.map((s) => gravityRoll([s.ax, s.ay, s.az], calibration));
  for (let i = gap; i < twist.length; i++) {
    if (rolls[i] === null || rolls[i - gap] === null) continue;
    let turned = 0;
    for (let j = i - gap + 1; j <= i; j++) turned += rateAbout(twist[j], calibration.twistVec, calibration.bias);
    agreement += wrap(rolls[i] - rolls[i - gap]) * turned;
  }
  return agreement < 0 ? -1 : 1;
}

/** The flick threshold for this wearer: the fixed one, or lower for a gentle calibrated flick. */
export function flickThreshold(calibration, config = CONFIG) {
  if (!calibration.flickPeak) return config.flickMinDps;
  return Math.min(config.flickMinDps, Math.max(config.flickFloorDps, calibration.flickPeak * config.flickPeakShare));
}

/** Forearm elevation in degrees: how far gravity leans along the twist (forearm) axis. */
function elevation(gravity, twistVec) {
  return Math.asin(Math.max(-1, Math.min(1, dot(unit(gravity), twistVec)))) * DEG;
}

/** How far the arm is from the level pose, in degrees. */
export function clutchAngle(gravity, calibration, config = CONFIG) {
  if (!config.clutchIgnoresTwist) return angleBetween(gravity, calibration.gravity);
  return Math.abs(elevation(gravity, calibration.twistVec) - elevation(calibration.gravity, calibration.twistVec));
}

/**
 * The gesture state machine. Feed it every motion sample and every tap event; it returns
 * the outgoing messages each call produces (usually none).
 *   update(sample)   sample = { t, ax, ay, az, gx, gy, gz }
 *   tap(kind, t)     kind = 'tap' or 'double-tap'
 *   state            { clutch, angle, twisting, roll, missedFlick } for the page
 *
 * How it decides, borrowed from how watches do it:
 * - It tracks the wrist's real angle (gyro, kept honest by gravity), not raw turning speed.
 * - Twist is measured from where the wrist was resting. Turning away sends adjusts, turning
 *   back sends nothing, so one twist never undoes itself.
 * - Twist or flick is decided by which axis is stronger at that moment, not by fixed limits.
 * - One action per motion, then a cooldown.
 */
export function createDetector(calibration, config = CONFIG) {
  const bias = calibration.bias || NO_BIAS;
  const flickMin = flickThreshold(calibration, config);
  const cw = calibration.rollSign || 1;            // turns the tracked angle clockwise-positive
  let gravity = null;          // smoothed gravity estimate, for the clutch
  let up = null;               // a slower one: which way is up, for the sideways (flick) axis
  let roll = null;             // wrist angle in gravityRoll's direction, degrees
  let zero = 0;                // the resting angle twists are measured from (clockwise-positive)
  let stillSince = null;
  let lastT = null;
  let cooldownUntil = -Infinity;
  let twist = null;            // the twist in progress: { side, steps, lastMove }
  let counted = { side: 0, steps: 0 };   // adjusts already sent on one side of the current zero
  let returnUntil = -Infinity; // until then the wrist may turn back without it counting
  let returnSide = 0;
  let spike = null;            // flick candidate: { start, sign, flick, twist }
  let peakFlick = 0;           // recent peaks on the two axes, fading
  let peakTwist = 0;
  let toggleAt = null;         // a held-back toggle fires at this time
  const state = { clutch: false, angle: null, twisting: false, roll: 0, missedFlick: null, missedTwist: null, twistRate: 0, flickRate: 0, flickMin };

  function endTwist(t) {
    if (twist && twist.steps > 0) {
      cooldownUntil = t + config.cooldownMs;
      counted = { side: twist.side, steps: twist.steps };
      returnUntil = t + config.returnMs;
      returnSide = -twist.side;
    }
    twist = null;
  }

  function rest(angle) {                                 // the wrist is resting here: measure from here
    zero = angle;
    counted = { side: 0, steps: 0 };
  }

  function update(s) {
    const out = [];
    const dt = lastT === null ? 0 : Math.max(0, Math.min(0.05, (s.t - lastT) / 1000));
    lastT = s.t;
    const accel = [s.ax, s.ay, s.az];
    gravity = gravity === null ? accel : gravity.map((g, i) => g + config.gravitySmoothing * (accel[i] - g));
    up = up === null ? accel : up.map((g, i) => g + config.upSmoothing * (accel[i] - g));
    const twistRate = rateAbout(s, calibration.twistVec, bias);   // clockwise-positive
    // Sideways turning, right-positive: about the vertical, so it does not matter how the wrist is rolled.
    const flickRate = rateAbout(s, sidewaysAxis(up, calibration.twistVec), bias) * (calibration.flickSign || 1);
    state.angle = clutchAngle(gravity, calibration, config);
    state.clutch = state.angle <= config.clutchDegrees;

    // Wrist angle: integrate the gyro, and lean on gravity while the hand is not being shaken.
    const seen = gravityRoll(accel, calibration);
    if (roll === null) roll = seen === null ? 0 : seen;
    else {
      roll = wrap(roll + twistRate * cw * dt);
      if (seen !== null && Math.abs(Math.hypot(...accel) - 1) < 0.2) roll = wrap(roll + config.rollBlend * wrap(seen - roll));
    }
    const angle = roll * cw;                             // clockwise-positive

    const fade = Math.exp(-dt * 1000 / config.peakMemoryMs);
    peakFlick = Math.max(Math.abs(flickRate), peakFlick * fade);
    peakTwist = Math.max(Math.abs(twistRate), peakTwist * fade);
    const still = Math.abs(twistRate) < config.stillDps && Math.abs(flickRate) < config.stillDps;
    if (!still) stillSince = null; else if (stillSince === null) stillSince = s.t;
    const stillFor = stillSince === null ? 0 : s.t - stillSince;

    if (toggleAt !== null && s.t >= toggleAt) {          // no double-tap came: the tap was a toggle
      toggleAt = null;
      out.push({ type: 'toggle' });
      cooldownUntil = s.t + config.cooldownMs;
    }

    const mayRest = !twist && stillFor >= config.stillMs && s.t >= returnUntil;
    if (!state.clutch) { endTwist(s.t); spike = null; returnUntil = -Infinity; rest(angle); }
    else if (s.t < cooldownUntil) { spike = null; if (mayRest) rest(angle); }
    else {
      if (!twist) {                                      // flick: a short spike, stronger than the twist axis
        if (spike === null) {
          if (Math.abs(flickRate) >= flickMin) spike = { start: s.t, sign: flickRate > 0 ? 1 : -1, flick: peakFlick, twist: peakTwist };
        } else {
          spike.flick = Math.max(spike.flick, Math.abs(flickRate));
          spike.twist = Math.max(spike.twist, Math.abs(twistRate));
          if (spike.twist > spike.flick) {               // the twist axis took over: this is a twist
            state.missedFlick = `twist in it: flick ${Math.round(spike.flick)}, twist ${Math.round(spike.twist)} deg/s`;
            spike = null;
          } else if (Math.abs(flickRate) < flickMin) {
            const ms = s.t - spike.start;
            if (ms >= config.flickMaxMs) state.missedFlick = `too long: ${Math.round(ms)} ms`;
            else if (spike.flick < config.flickDominance * spike.twist) {
              state.missedFlick = `twist in it: flick ${Math.round(spike.flick)}, twist ${Math.round(spike.twist)} deg/s`;
            } else {
              out.push({ type: 'step', direction: spike.sign });
              cooldownUntil = s.t + config.cooldownMs;
              state.missedFlick = null;
            }
            spike = null;
          }
        }
      }

      const away = wrap(angle - zero);                   // degrees turned from the resting angle
      if (Math.abs(away) <= config.neutralDegrees) returnUntil = -Infinity;   // back at rest: the free return is used up
      if (!twist) {
        const side = Math.sign(away);
        if (mayRest) rest(angle);
        else if (Math.abs(away) >= config.twistStepDegrees && Math.abs(twistRate) >= config.twistMinDps && Math.sign(twistRate) === side) {
          // Turned far enough, fast enough. Start a twist, or say what stands in the way.
          if (spike !== null || peakTwist < peakFlick) state.missedTwist = 'the flick axis was stronger';
          else if (s.t < returnUntil && side === returnSide) state.missedTwist = 'counted as turning back after the last twist';
          else {
            twist = { side, steps: counted.side === side ? counted.steps : 0, lastMove: s.t };
            state.missedTwist = null;
          }
        }
      }
      if (twist) {
        if (Math.abs(twistRate) >= config.twistMinDps) twist.lastMove = s.t;
        const steps = Math.floor((twist.side * away) / config.twistStepDegrees);
        while (twist.steps < steps) {                    // further away than before: one adjust per step
          out.push({ type: 'adjust', delta: twist.side * config.adjustStep });
          twist.steps += 1;
        }
        // Over when the wrist came back, or stopped turning. Either way flicks and taps work again.
        if (twist.side * away <= config.neutralDegrees || s.t - twist.lastMove > config.twistEndMs) endTwist(s.t);
      }
    }

    state.twisting = twist !== null;
    state.twistRate = twistRate;
    state.flickRate = flickRate;
    state.roll = wrap(angle - zero);
    return out;
  }

  function tap(kind, t) {
    const busy = twist !== null || spike !== null;
    if (kind === 'double-tap') {
      const held = toggleAt !== null;
      toggleAt = null;                                   // the tap before it was not a toggle
      if (busy || (t < cooldownUntil && !held)) return [];
      cooldownUntil = t + config.cooldownMs;
      return [{ type: 'select' }];
    }
    if (busy || t < cooldownUntil || toggleAt !== null) return [];
    if (config.tapBeforeDoubleTap) { toggleAt = t + config.tapDelayMs; return []; }
    cooldownUntil = t + config.cooldownMs;
    return [{ type: 'toggle' }];
  }

  return { update, tap, state };
}
