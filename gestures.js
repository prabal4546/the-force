// Gesture maths for the band module. Pure functions and one small state machine:
// no band, no page, no timers. Time comes from each sample's own `t` (milliseconds).

// Every threshold in one place.
export const CONFIG = {
  motionRate: 100,          // samples a second asked from the band

  // Calibration
  poseMs: 2000,             // how long each calibration pose is recorded
  minPoseDps: 20,           // a twist or flick pose must move at least this much (RMS, deg/s)
  swingSignDps: 60,         // first swing above this decides which way is "clockwise" / "right"

  // Clutch: twist and flick only count near the level pose
  clutchDegrees: 35,
  clutchIgnoresTwist: true, // true: compare forearm elevation only, so turning the wrist does not
                            //       open the clutch. false: plain angle between gravity directions.
  gravitySmoothing: 0.1,    // 0..1, share of each new sample in the gravity estimate

  // Wrist angle (roll about the forearm): the gyro for speed, gravity to stop it drifting
  rollBlend: 0.02,          // share of the gravity reading pulled into the angle on each sample
  stillDps: 25,             // below this on both axes the wrist counts as resting
  stillMs: 300,             // resting this long makes the current angle the new zero

  // Twist: turn away from the resting angle to adjust; turning back is free
  twistMinDps: 30,          // a twist only starts while turning at least this fast
  twistStepDegrees: 15,     // one adjust message per this many degrees turned away
  adjustStep: 0.05,         // the delta in each adjust message
  neutralDegrees: 10,       // back within this of the resting angle, the twist is over
  twistHoldMs: 4000,        // held still this long while turned, that angle becomes the new zero

  // Flick: a short spike on the flick axis that is stronger than the twist axis
  flickMinDps: 250,         // the spike must exceed this ...
  flickPeakShare: 0.5,      // ... or this share of the wearer's calibrated flick, if that is less
  flickFloorDps: 150,       // but never less than this
  flickMaxMs: 200,          // and must be shorter than this
  flickDominance: 1.5,      // flick axis at least this many times the twist axis ("twist-free")
  peakMemoryMs: 120,        // how long a peak is remembered when comparing the two axes

  // Taps
  tapBeforeDoubleTap: true, // the band sends a tap before a double-tap: hold toggle back
  tapDelayMs: 300,          // how long toggle waits for a double-tap to cancel it
  tapCheckMs: 600,          // a tap this close before a double-tap counts as "sent before it"

  // Raise to talk
  raiseDegrees: 45,         // forearm this far above the level pose ...
  raiseHoldMs: 300,         // ... for this long turns the microphone on
  voiceEndMs: 900,          // this long after a finished sentence with nothing new, the command is sent
  voiceMaxMs: 15000,        // the microphone never stays on longer than this in one raise

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

/** Sign of the first clear swing on one axis: +1 or -1. */
export function firstSwingSign(samples, axis, threshold) {
  const first = samples.find((s) => Math.abs(s[axis]) >= threshold);
  return first && first[axis] < 0 ? -1 : 1;
}

/**
 * Turn the three recorded poses into a calibration.
 * The person starts the twist clockwise and the flick to the right, so the first swing
 * of each recording fixes the sign of "clockwise" and "right".
 */
export function computeCalibration(level, twist, flick, raise = null, config = CONFIG) {
  if (level.length < 10 || twist.length < 10 || flick.length < 10) {
    throw new Error('Too few motion samples were recorded. Is the band still connected?');
  }
  const twistEnergy = gyroEnergy(twist);
  const twistAxis = GYRO.reduce((best, axis) => (twistEnergy[axis] > twistEnergy[best] ? axis : best));
  if (twistEnergy[twistAxis] < config.minPoseDps) {
    throw new Error('The twist pose hardly moved. Turn your wrist like a doorknob for the whole 2 seconds.');
  }
  const flickEnergy = gyroEnergy(flick);
  const rest = GYRO.filter((axis) => axis !== twistAxis);
  const flickAxis = flickEnergy[rest[0]] >= flickEnergy[rest[1]] ? rest[0] : rest[1];
  if (flickEnergy[flickAxis] < config.minPoseDps) {
    throw new Error('The flick pose hardly moved. Flick your hand side to side for the whole 2 seconds.');
  }
  const gravity = meanGravity(level);
  const bias = {};                                 // what the gyro reads while the arm is still
  for (const axis of GYRO) bias[axis] = level.reduce((sum, s) => sum + s[axis], 0) / level.length;
  const calibration = {
    gravity,
    bias,
    twistAxis,
    flickAxis,
    twistSign: firstSwingSign(twist, twistAxis, config.swingSignDps),
    flickSign: firstSwingSign(flick, flickAxis, config.swingSignDps),
    rollSign: rollDirection(twist, twistAxis, gravity),
    flickPeak: percentile(flick.map((s) => Math.abs(s[flickAxis] - bias[flickAxis])), 0.95),
  };
  if (raise && raise.length >= 10) {               // which way is "up", and how far the raise pose went
    const lift = elevation(meanGravity(raise), twistAxis) - elevation(calibration.gravity, twistAxis);
    calibration.raiseSign = lift < 0 ? -1 : 1;
    calibration.raiseDegrees = Math.abs(lift);
  }
  return calibration;
}

const wrap = (degrees) => ((degrees + 540) % 360) - 180;          // into -180..180

function percentile(values, share) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * Wrist roll about the forearm (twist) axis as gravity shows it, in degrees from the level
 * pose. Drift-free but shaky while the hand moves. Null when gravity lies along the forearm.
 */
export function gravityRoll(accel, twistAxis, levelGravity) {
  const t = GYRO.indexOf(twistAxis), p = (t + 1) % 3, q = (t + 2) % 3;
  if (Math.hypot(accel[p], accel[q]) < 0.4) return null;
  return wrap((Math.atan2(accel[q], accel[p]) - Math.atan2(levelGravity[q], levelGravity[p])) * DEG);
}

/** +1 when the gyro's twist axis and gravityRoll turn the same way, -1 when opposite. */
function rollDirection(twist, twistAxis, levelGravity) {
  let agreement = 0;
  const gap = 5;                                   // compare over 5 samples: steadier than one
  for (let i = gap; i < twist.length; i++) {
    const now = gravityRoll(ACCEL.map((k) => twist[i][k]), twistAxis, levelGravity);
    const before = gravityRoll(ACCEL.map((k) => twist[i - gap][k]), twistAxis, levelGravity);
    if (now === null || before === null) continue;
    let turned = 0;
    for (let j = i - gap + 1; j <= i; j++) turned += twist[j][twistAxis];
    agreement += wrap(now - before) * turned;
  }
  return agreement < 0 ? -1 : 1;
}

/** The flick threshold for this wearer: the fixed one, or lower for a gentle calibrated flick. */
export function flickThreshold(calibration, config = CONFIG) {
  if (!calibration.flickPeak) return config.flickMinDps;
  return Math.min(config.flickMinDps, Math.max(config.flickFloorDps, calibration.flickPeak * config.flickPeakShare));
}

/** Forearm elevation in degrees: how far gravity leans along the twist (forearm) axis. */
function elevation(gravity, twistAxis) {
  const along = unit(gravity)[GYRO.indexOf(twistAxis)];
  return Math.asin(Math.max(-1, Math.min(1, along))) * DEG;
}

/** Degrees the forearm is lifted above the level pose (negative: below it, as when the arm hangs). */
export function liftAngle(gravity, calibration) {
  const lift = elevation(gravity, calibration.twistAxis) - elevation(calibration.gravity, calibration.twistAxis);
  return lift * (calibration.raiseSign || 1);
}

/**
 * Raise to talk. Feed it every motion sample; it answers 'raise' once the forearm has been
 * lifted more than raiseDegrees for raiseHoldMs, 'lower' when the arm is level again, and
 * null the rest of the time. A hanging arm is below level, so it never counts as a raise.
 */
export function createRaiseDetector(calibration, config = CONFIG) {
  let gravity = null;
  let liftedSince = null;
  const state = { raised: false, lift: null };

  function update(s) {
    const accel = [s.ax, s.ay, s.az];
    gravity = gravity === null ? accel : gravity.map((g, i) => g + config.gravitySmoothing * (accel[i] - g));
    state.lift = liftAngle(gravity, calibration);
    if (!state.raised) {
      if (state.lift <= config.raiseDegrees) { liftedSince = null; return null; }
      if (liftedSince === null) liftedSince = s.t;
      if (s.t - liftedSince < config.raiseHoldMs) return null;
      state.raised = true;
      return 'raise';
    }
    if (Math.abs(state.lift) > config.clutchDegrees) return null;
    state.raised = false;
    liftedSince = null;
    return 'lower';
  }

  return { update, state };
}

/** How far the arm is from the level pose, in degrees. */
export function clutchAngle(gravity, calibration, config = CONFIG) {
  if (!config.clutchIgnoresTwist) return angleBetween(gravity, calibration.gravity);
  return Math.abs(elevation(gravity, calibration.twistAxis) - elevation(calibration.gravity, calibration.twistAxis));
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
  const bias = calibration.bias || { gx: 0, gy: 0, gz: 0 };
  const flickMin = flickThreshold(calibration, config);
  const cw = (calibration.rollSign || 1) * calibration.twistSign;   // turns the tracked angle clockwise-positive
  let gravity = null;          // smoothed gravity estimate, for the clutch
  let roll = null;             // wrist angle in gravityRoll's direction, degrees
  let zero = 0;                // the resting angle twists are measured from (clockwise-positive)
  let stillSince = null;
  let lastT = null;
  let cooldownUntil = -Infinity;
  let twist = null;            // the twist in progress: { side, steps }
  let spike = null;            // flick candidate: { start, sign, flick, twist }
  let peakFlick = 0;           // recent peaks on the two axes, fading
  let peakTwist = 0;
  let toggleAt = null;         // a held-back toggle fires at this time
  const state = { clutch: false, angle: null, twisting: false, roll: 0, missedFlick: null };

  function endTwist(t) {
    if (twist && twist.steps > 0) cooldownUntil = t + config.cooldownMs;
    twist = null;
  }

  function update(s) {
    const out = [];
    const dt = lastT === null ? 0 : Math.max(0, Math.min(0.05, (s.t - lastT) / 1000));
    lastT = s.t;
    const accel = [s.ax, s.ay, s.az];
    const twistRate = (s[calibration.twistAxis] - bias[calibration.twistAxis]) * calibration.twistSign;   // clockwise-positive
    const flickRate = (s[calibration.flickAxis] - bias[calibration.flickAxis]) * calibration.flickSign;   // right-positive

    gravity = gravity === null ? accel : gravity.map((g, i) => g + config.gravitySmoothing * (accel[i] - g));
    state.angle = clutchAngle(gravity, calibration, config);
    state.clutch = state.angle <= config.clutchDegrees;

    // Wrist angle: integrate the gyro, and lean on gravity while the hand is not being shaken.
    const seen = gravityRoll(accel, calibration.twistAxis, calibration.gravity);
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

    if (!state.clutch) { endTwist(s.t); spike = null; zero = angle; }
    else if (s.t < cooldownUntil) { spike = null; if (!twist && stillFor >= config.stillMs) zero = angle; }
    else {
      if (!twist) {                                      // flick: a short spike, stronger than the twist axis
        if (spike === null) {
          if (Math.abs(flickRate) >= flickMin) spike = { start: s.t, sign: flickRate > 0 ? 1 : -1, flick: peakFlick, twist: peakTwist };
        } else {
          spike.flick = Math.max(spike.flick, Math.abs(flickRate));
          spike.twist = Math.max(spike.twist, Math.abs(twistRate));
          if (Math.abs(flickRate) < flickMin) {
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
      if (!twist) {
        if (stillFor >= config.stillMs) zero = angle;    // resting: this is the new zero
        else if (spike === null && s.t >= cooldownUntil && peakTwist >= peakFlick
          && Math.abs(away) >= config.twistStepDegrees && Math.abs(twistRate) >= config.twistMinDps
          && Math.sign(twistRate) === Math.sign(away)) {
          twist = { side: Math.sign(away), steps: 0 };
        }
      }
      if (twist) {
        const steps = Math.floor((twist.side * away) / config.twistStepDegrees);
        while (twist.steps < steps) {                    // further away than before: one adjust per step
          out.push({ type: 'adjust', delta: twist.side * config.adjustStep });
          twist.steps += 1;
        }
        if (twist.side * away <= config.neutralDegrees) endTwist(s.t);                  // came back
        else if (stillFor >= config.twistHoldMs) { endTwist(s.t); zero = angle; }       // stayed turned
      }
    }

    state.twisting = twist !== null;
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
