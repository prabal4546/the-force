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

  // Twist
  twistMinDps: 30,          // integrate only above this turning speed
  twistStepDegrees: 15,     // one adjust message per this many degrees
  adjustStep: 0.05,         // the delta in each adjust message
  twistEndMs: 250,          // a twist is over after this long below twistMinDps

  // Flick
  flickMinDps: 250,         // spike on the flick axis must exceed this
  flickMaxMs: 200,          // and must be shorter than this
  flickMaxTwistDps: 120,    // "twist-free": twist axis stays below this during the spike

  // Taps
  tapBeforeDoubleTap: true, // the band sends a tap before a double-tap: hold toggle back
  tapDelayMs: 300,          // how long toggle waits for a double-tap to cancel it
  tapCheckMs: 600,          // a tap this close before a double-tap counts as "sent before it"

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
export function computeCalibration(level, twist, flick, config = CONFIG) {
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
  return {
    gravity: meanGravity(level),
    twistAxis,
    flickAxis,
    twistSign: firstSwingSign(twist, twistAxis, config.swingSignDps),
    flickSign: firstSwingSign(flick, flickAxis, config.swingSignDps),
  };
}

/** Forearm elevation in degrees: how far gravity leans along the twist (forearm) axis. */
function elevation(gravity, twistAxis) {
  const along = unit(gravity)[GYRO.indexOf(twistAxis)];
  return Math.asin(Math.max(-1, Math.min(1, along))) * DEG;
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
 *   state            { clutch, angle, twisting } for the page
 */
export function createDetector(calibration, config = CONFIG) {
  let gravity = null;          // smoothed gravity estimate
  let lastT = null;
  let cooldownUntil = -Infinity;
  let turned = 0;              // degrees turned since the last adjust
  let lastTwistT = -Infinity;
  let twisting = false;        // a twist has sent at least one adjust and is not over yet
  let spike = null;            // flick candidate: { start, sign, clean }
  let toggleAt = null;         // a held-back toggle fires at this time
  const state = { clutch: false, angle: null, twisting: false };

  function endTwist(t) {
    if (twisting) cooldownUntil = t + config.cooldownMs;
    twisting = false;
    turned = 0;
  }

  function update(s) {
    const out = [];
    const dt = lastT === null ? 0 : Math.max(0, Math.min(0.05, (s.t - lastT) / 1000));
    lastT = s.t;

    const accel = [s.ax, s.ay, s.az];
    gravity = gravity === null ? accel : gravity.map((g, i) => g + config.gravitySmoothing * (accel[i] - g));
    state.angle = clutchAngle(gravity, calibration, config);
    state.clutch = state.angle <= config.clutchDegrees;

    if (toggleAt !== null && s.t >= toggleAt) {          // no double-tap came: the tap was a toggle
      toggleAt = null;
      out.push({ type: 'toggle' });
      cooldownUntil = s.t + config.cooldownMs;
    }

    if (!state.clutch) { endTwist(s.t); spike = null; }
    else if (s.t < cooldownUntil) { turned = 0; spike = null; }
    else {
      const twist = s[calibration.twistAxis] * calibration.twistSign;
      const flick = s[calibration.flickAxis] * calibration.flickSign;

      if (!twisting) {                                   // flick: a short, twist-free spike
        if (spike === null) {
          if (Math.abs(flick) >= config.flickMinDps && Math.abs(twist) < config.flickMaxTwistDps) {
            spike = { start: s.t, sign: flick > 0 ? 1 : -1, clean: true };
          }
        } else {
          if (Math.abs(twist) >= config.flickMaxTwistDps) spike.clean = false;
          if (Math.abs(flick) < config.flickMinDps) {
            if (spike.clean && s.t - spike.start < config.flickMaxMs) {
              out.push({ type: 'step', direction: spike.sign });
              cooldownUntil = s.t + config.cooldownMs;
            }
            spike = null;
          }
        }
      }

      if (spike !== null) turned = 0;                    // a flick in progress is not a twist
      else if (s.t >= cooldownUntil) {
        if (Math.abs(twist) >= config.twistMinDps) {
          turned += twist * dt;
          lastTwistT = s.t;
          while (Math.abs(turned) >= config.twistStepDegrees) {
            const sign = turned > 0 ? 1 : -1;
            out.push({ type: 'adjust', delta: sign * config.adjustStep });
            turned -= sign * config.twistStepDegrees;
            twisting = true;
          }
        } else if (s.t - lastTwistT > config.twistEndMs) endTwist(s.t);
      }
    }

    state.twisting = twisting;
    return out;
  }

  function tap(kind, t) {
    if (kind === 'double-tap') {
      const held = toggleAt !== null;
      toggleAt = null;                                   // the tap before it was not a toggle
      if (twisting || spike !== null || (t < cooldownUntil && !held)) return [];
      cooldownUntil = t + config.cooldownMs;
      return [{ type: 'select' }];
    }
    if (twisting || spike !== null || t < cooldownUntil || toggleAt !== null) return [];
    if (config.tapBeforeDoubleTap) { toggleAt = t + config.tapDelayMs; return []; }
    cooldownUntil = t + config.cooldownMs;
    return [{ type: 'toggle' }];
  }

  return { update, tap, state };
}
