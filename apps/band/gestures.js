// Gesture maths for the band module. Pure functions and one small state machine:
// no band, no page, no timers. Time comes from each sample's own `t` (milliseconds).

// Every threshold in one place.
export const CONFIG = {
  motionRate: 100,          // samples a second asked from the band
  motionFallbackRate: 50,   // used instead once the link reports dropped stream data

  // Calibration
  poseMs: 2000,             // how long each calibration pose is recorded
  minPoseDps: 20,           // a twist or swipe pose must move at least this much (RMS, deg/s)
  holdMaxDps: 30,           // a hold-still pose must move less than this (RMS, deg/s)
  swingSignDps: 60,         // first swing above this decides which way is "clockwise" / "right"
  sidewaysShare: 0.5,       // a calibrated swipe must be at least this much sideways (not up and down)

  // Clutch: twist and swipe only count near the level pose
  clutchDegrees: 50,
  clutchIgnoresTwist: true, // true: compare forearm elevation only, so turning the wrist does not
                            //       open the clutch. false: plain angle between gravity directions.
  gravitySmoothing: 0.1,    // 0..1, share of each new sample in the gravity estimate
  upSmoothing: 0.03,        // the same for "which way is up", slower so a swipe does not disturb it

  // Which gestures the arm makes
  gestures: 'turn',         // 'turn': every quick turn of the wrist is one step in its direction, right
                            //   (clockwise) or left. A slow turn is free: that is how to get back and step
                            //   the same way again. Read from the gyro, about the forearm only.
                            // 'tilt': tip the wrist to the right or left and come back, like a joystick: one
                            //   step each, and coming back never counts. Read from gravity.
                            // 'leftRight': one motion read from turning speed. Sweeping the forearm or turning
                            //   the wrist, right (or clockwise) or left: each is one step, +1 or -1.
                            // 'twistAndSwipe': two motions told apart. Twist sends adjusts, swipe sends steps.

  // Turn: a quick turn of the wrist about the forearm. The numbers come from a recording of
  // the real band: deliberate turns were 70 to 200 degrees, peaking at 360 to 1000 deg/s;
  // wobbles and creeping stayed under 40 degrees or 170 deg/s.
  turnStartDps: 60,         // the wrist turning this fast starts a turn ...
  turnEndDps: 30,           // ... and slower than this ...
  turnEndMs: 80,            // ... for this long ends it (so does turning back the other way)
  turnOutDegrees: 45,       // a turn must go this far outward (the easy way, see wearingArm) ...
  turnInDegrees: 40,        // ... or this far inward
  turnMinDps: 250,          // and peak this fast: slower is moving the wrist back, not a gesture
  turnArmShare: 0.5,        // the arm itself may turn at most this share of what the wrist turned.
                            //   More is the arm moving around, not a turn of the wrist
  // The wrist's axis is found in calibration, but a band shifts on the wrist, and then every
  // turn of the wrist looks partly like the arm moving. So the axis is also learned in use:
  // each big, quick, clean turn close to the axis known so far pulls it a little its way.
  turnAxisLearn: 0.4,       // 0..1, how far one such turn moves the axis towards its own. 0: calibration only
  turnAxisMinDegrees: 60,   // only turns this big teach (and at least turnMinDps quick)
  turnAxisPurity: 0.9,      // ... that were one clean rotation: net turn at least this share of all turning
  turnAxisMaxDegrees: 30,   // ... about a direction within this of the axis known so far
  turnAxisMaxDrift: 45,     // the learned axis never goes further than this from the calibrated one
  turnPauseMs: 150,         // after the turn the wrist must pause this long before the step is sent. It
                            //   filters a shake, a turn undone at once and a turn that runs on into arm
                            //   movement, and it makes every step that much later. 0: send it mid-turn
  turnPauseDps: 150,        // "paused": wrist and arm both turning slower than this. Loose on purpose: a
                            //   wrist keeps settling for a few tenths of a second after a big quick turn
  turnPauseWaitMs: 1000,    // no pause within this long: it was not a gesture

  // Tilt: how far the wrist is tipped from where it was resting, measured against gravity
  wearingArm: 'left',       // 'left' or 'right': the arm the band is on. A forearm turns outward (thumb away
                            //   from the body, palm coming up) further and more easily than inward. Outward
                            //   is to the left on the left arm and to the right on the right arm.
  tiltOutDegrees: 30,       // tipped this far outward of the centre: one step
  tiltInDegrees: 24,        // the same inward, the harder way: less is asked
  // The room left to turn also depends on where the wrist rests. Measured from the calibrated
  // level pose (thumb up), a forearm turns about this far each way:
  tiltOutRange: 85,
  tiltInRange: 75,
  tiltRangeShare: 0,        // above 0: a step never asks for more than this share of the room left on that
                            //   side (resting palm down leaves little room inward). It only fits if the level
                            //   pose in calibration was thumb up. 0: off, the two distances are used as they are
  tiltMinDegrees: 15,       // with the share on: always at least this
  tiltReturnDegrees: 12,    // back within this of rest (or 0.6 of the step distance, if that is less): ready for the next one
  tiltHoldMs: 60,           // it must stay past the line this long (a shake does not)
  tiltCentreFollow: 0.02,   // 0..1 a sample: how fast the centre follows a wrist resting near it
  tiltArmDps: 70,           // the arm itself is moving: turning this fast about anything but the forearm
  tiltArmLeak: 0.4,         //   (plus this share of the wrist's own turning: no wrist turns about one line only)
  tiltArmMs: 40,            //   for this long ...
  tiltArmDegrees: 20,       // ... or the forearm raised or lowered this far since the centre was set.
                            //   Then the centre is forgotten, and found again once the arm is still
  tiltRestDps: 20,          // turning slower than this, the wrist is resting ...
  tiltRecentreMs: 1500,     // ... and after resting this long, where it rests is the new centre
                            //   (twice as long while it is still tipped after a step)
  tiltSmoothing: 0.2,       // 0..1, share of each new sample in the gravity used for the tilt
  tiltMaxShake: 0.3,        // a sample whose acceleration is this far from 1 g is a jolt: left out

  // A movement: from the first turning until the arm is still again. Its first moments decide
  // which axis it is on (and so, with 'twistAndSwipe', whether it is a twist or a swipe).
  moveStartDps: 40,         // either axis above this starts a movement
  classifyMs: 120,          // how long the two axes are compared
  dominanceRatio: 1.5,      // 'twistAndSwipe' only: the winner did at least this many times as much as the other
  stillDps: 20,             // both axes below this ...
  stillMs: 150,             // ... for this long: the movement is over

  // Ghosts: movement that was never meant as a gesture (reaching, walking, the swing back, a bump)
  settleMs: 150,            // a gesture only starts from an arm held level and calm for this long. 0: off
  settleDps: 60,            // "calm": the whole band turning slower than this, about any direction
  settleGraceMs: 120,       // the calm may have ended this long before the movement starts

  // Twist: the forearm turns like a doorknob
  twistStartDegrees: 20,    // nothing is sent until the wrist has turned this far
  twistStepDegrees: 15,     // 'twistAndSwipe' only: then one adjust message per this many degrees further
  adjustStep: 0.05,         // the delta in each adjust message
  returnMs: 1000,           // moving back the other way this soon after a counted one is the return: not counted
                            //   ('twistAndSwipe': twists only)

  // Swipe: the forearm sweeps sideways, pivoting at the elbow
  swipeAxis: 'vertical',    // 'vertical': turning about the vertical, known from gravity, so the same
                            //   sweep counts however the wrist is rolled. 'calibrated': the fixed
                            //   direction in the band that the calibration swipe turned about.
  swipeMinDps: 250,         // the sweep's peak must exceed this ...
  swipeFromCalibration: true,   // (false: swipeMinDps alone decides, as when it is tuned by hand)
  swipePeakShare: 0.5,      // ... or this share of the wearer's calibrated swipe, if that is less
  swipeFloorDps: 150,       // but never less than this
  swipeMinDegrees: 12,      // and the forearm must sweep through this angle: a jolt is fast but goes nowhere
  swipeMaxMs: 350,          // and it must be over within this; longer movement on that axis is ignored

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
const NO_BIAS = { gx: 0, gy: 0, gz: 0 };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function unit(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/** Angle between two directions, in degrees. */
export function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG;
}

/** Average gravity direction of a recording, as a unit vector. */
export function meanGravity(samples) {
  const sum = [0, 0, 0];
  for (const s of samples) ACCEL.forEach((k, i) => { sum[i] += s[k]; });
  return unit(sum);
}

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
 * direction to leave out first (the twist axis, when looking for the swipe axis).
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
 * sideways sweep of the forearm turns about. It follows gravity, so it is the same motion
 * in the room whether the palm faces down, the thumb is up, or anything between.
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

function percentile(values, share) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * Is one recorded calibration pose usable? Returns null when it is, or a sentence saying
 * what to do differently. `kind` is 'level', 'twist' or 'swipe'; `poses` holds the
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
      : 'That hardly moved. Sweep your forearm left and right the whole time.';
  }
  if (kind === 'swipe' && poses.twist) {
    const twistAxis = mainAxis(poses.twist);
    const all = energyAbout(samples, mainAxis(samples, NO_BIAS, twistAxis), NO_BIAS, twistAxis);
    if (all < config.minPoseDps || all < energyAbout(samples, twistAxis)) {
      return 'That was mostly a twist. Keep your wrist from turning: pivot at the elbow and sweep the whole forearm left and right.';
    }
    const sideways = energyAbout(samples, sidewaysAxis(meanGravity(samples), twistAxis));
    if (sideways < config.minPoseDps || sideways < config.sidewaysShare * all) {
      return 'Your forearm moved up and down more than sideways. Sweep it left and right, level with the floor.';
    }
  }
  return null;
}

/**
 * Turn the three recorded poses into a calibration.
 * The twist axis is the direction the twist pose turned about. The swipe axis is the main
 * direction of the swipe pose once the twist direction is taken out, so the two never
 * overlap. The person starts the twist clockwise and the swipe to the right: the first
 * swing of each recording fixes which way is positive.
 */
export function computeCalibration(level, twist, swipe = null, config = CONFIG) {
  if (level.length < 10 || twist.length < 10 || (swipe && swipe.length < 10)) {
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

  // Check which way gravity turns when the wrist turns clockwise, against the gyro, on the
  // twist recording itself: 1 on a band whose two sensors agree, as they should.
  let agree = 0, before = null;
  for (const sample of twist) {
    const roll = wristRoll([sample.ax, sample.ay, sample.az], { gravity, twistVec });
    if (before !== null) agree += wrap(roll - before) * rateAbout(sample, twistVec, bias);
    before = roll;
  }
  const rollSign = agree < 0 ? -1 : 1;
  if (!swipe) {                                    // the tilt needs no swipe: two poses are enough
    return { version: 3, gravity, bias, twistVec, rollSign, swipeVec: null, swipeSign: 1, twistAxis: letter(twistVec), swipeAxis: null, swipePeak: 0 };
  }

  let swipeVec = mainAxis(swipe, bias, twistVec);
  if (energyAbout(swipe, swipeVec, bias) < config.minPoseDps) {
    throw new Error('The swipe pose hardly moved. Sweep your forearm left and right for the whole 2 seconds.');
  }
  swipeVec = firstSwingPositive(swipe, swipeVec, bias, config.swingSignDps);

  // The same sweep seen as turning about the vertical: its sign and its strength.
  const side = sidewaysAxis(meanGravity(swipe), twistVec);
  const sideways = energyAbout(swipe, side, bias);
  if (sideways < config.minPoseDps || sideways < config.sidewaysShare * energyAbout(swipe, swipeVec, bias)) {
    throw new Error('The swipe went up and down more than sideways. Sweep your forearm left and right, level with the floor.');
  }
  const first = swipe.find((s) => Math.abs(rateAbout(s, side, bias)) >= config.swingSignDps);
  const swipeSign = first && rateAbout(first, side, bias) < 0 ? -1 : 1;
  const used = config.swipeAxis === 'calibrated' ? swipeVec : side;

  return {
    version: 3,
    gravity, bias, twistVec, rollSign, swipeVec, swipeSign,
    twistAxis: letter(twistVec), swipeAxis: letter(swipeVec),
    swipePeak: percentile(swipe.map((s) => Math.abs(rateAbout(s, used, bias))), 0.95),
  };
}

/** The swipe threshold for this wearer: the fixed one, or lower for a gentle calibrated swipe. */
export function swipeThreshold(calibration, config = CONFIG) {
  if (!calibration.swipePeak || config.swipeFromCalibration === false) return config.swipeMinDps;
  return Math.min(config.swipeMinDps, Math.max(config.swipeFloorDps, calibration.swipePeak * config.swipePeakShare));
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * How far the wrist is turned about the forearm, in degrees, clockwise-positive, compared
 * with the calibrated level pose. It comes from gravity alone: an angle, not a speed added
 * up, so it cannot drift. Only meaningful while the forearm is not near vertical.
 */
export function wristRoll(gravity, calibration) {
  const a = calibration.twistVec;
  const flat = (v) => { const along = dot(v, a); return v.map((x, i) => x - along * a[i]); };
  const from = flat(calibration.gravity), to = flat(gravity);
  // The band turning one way makes gravity, as the band sees it, turn the other way.
  return -Math.atan2(dot(cross(from, to), a), dot(from, to)) * DEG * (calibration.rollSign || 1);
}

const wrap = (degrees) => ((degrees + 540) % 360) - 180;        // into -180..180

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
 *   state            for the page: clutch, calm, live rates, and `movement`, the last movement:
 *                    { swipe, twist (degrees in the comparison), winner, result, counted }
 *
 * The config is read on every sample, so its values can be changed while it runs.
 *
 * A movement starts when either axis turns faster than moveStartDps and lasts until both
 * are still again. Its first classifyMs decide what it is: the axis that did dominanceRatio
 * times as much as the other wins, and the rest of the movement belongs to that gesture.
 * With no clear winner, nothing is sent.
 *
 * With config.gestures 'turn' (the default) only the wrist's turning about the forearm is
 * looked at. A turn runs from the first quick turning until it stops or turns back. Far
 * enough, fast enough, and with the arm itself mostly still, it is one step in its direction.
 *
 * With config.gestures 'tilt' none of that runs. The wrist's angle about the forearm is read
 * from gravity. Where it rests is the centre; tipped far enough from there is one step, and
 * it has to come back near the centre before the next. Coming back never sends anything.
 *
 * With config.gestures 'leftRight' the two are one gesture: whichever axis did more gives the
 * direction (right or clockwise is +1), and the movement sends a single step.
 *
 * A movement only starts from a calm arm (settleMs): what follows other movement, such as
 * reaching for something or the swing back after a swipe, is not looked at.
 */
export function createDetector(calibration, config = CONFIG) {
  const bias = calibration.bias || NO_BIAS;
  let swipeMin = swipeThreshold(calibration, config);
  let calmSince = null;        // the arm has been level and calm since this time ...
  let calmFor = 0;             // ... the most recent calm lasted this long ...
  let calmEndedAt = -Infinity; // ... and was last seen at this time
  let gravity = null;          // smoothed gravity estimate, for the clutch
  let up = null;               // a slower one: which way is up, for the sideways axis
  let lastT = null;
  let stillSince = null;
  let cooldownUntil = -Infinity;
  let toggleAt = null;         // a held-back toggle fires at this time
  let move = null;             // the movement in progress
  let lastTwist = { side: 0, endedAt: -Infinity };
  const state = {
    clutch: false, calm: false, moving: false, angle: null, twisting: false, roll: 0, twistRate: 0, swipeRate: 0, swipeMin,
    axisOff: Array.isArray(calibration.wristAxis) ? angleBetween(calibration.wristAxis, calibration.twistVec) : 0,
    axis: calibration.wristAxis || calibration.twistVec, movement: null, missed: null, limitRight: CONFIG.tiltOutDegrees, limitLeft: CONFIG.tiltOutDegrees, armed: false,
  };

  // Tilt
  let tiltGravity = null;      // gravity for the tilt: smoothed, jolts left out
  let neutral = null;          // the roll the wrist rests at: the centre
  let armed = false;           // back at the centre since the last step
  let restSince = null;        // the wrist has hardly turned since this time
  let beyondSince = null;      // tipped past the line since this time
  let tiltPeak = 0;            // furthest from the centre since it was last there

  function tiltNote(roll, result, counted) {
    state.movement = { swipe: 0, twist: roll, winner: 'tilt', result, counted };
    state.missed = counted ? null : result;
  }

  let centreSum = 0, centreCount = 0, centreFirst = 0;   // rolls seen while the centre is being found
  let centreLift = 0;          // forearm elevation when the centre was set
  let armSince = null;         // the arm itself has been turning since this time

  // Turn
  let turn = null;             // the wrist turn in progress: { side, angle, arm, peak, fired, left, rot, path }
  // The wrist's axis: calibrated, then learned from clear turns (and kept by the page as calibration.wristAxis)
  let wristAxis = (Array.isArray(calibration.wristAxis) ? calibration.wristAxis : calibration.twistVec).slice();
  let turnQuiet = null;        // the wrist has turned slower than turnEndDps since this time
  let waiting = null;          // a turn that qualified and now waits for the pause: { at, side, angle, wrist, arm, back, since }

  function turnNote(angle, arm, result, counted) {
    state.movement = { swipe: arm, twist: angle, winner: 'turn', result, counted };
    state.missed = counted ? null : result;
  }

  function sendTurn(t, side, angle, arm, out) {
    out.push({ type: 'step', direction: side });
    cooldownUntil = t + config.cooldownMs;
    turnNote(angle, arm, side > 0 ? 'Right' : 'Left', true);
  }

  /** Learn the wrist's axis from the turn that just ended, if it was a clear one. */
  function learnAxis() {
    const total = Math.hypot(...turn.rot);
    if (config.turnAxisLearn <= 0 || turn.left || total < config.turnAxisMinDegrees || turn.peak < config.turnMinDps) return;
    if (total < config.turnAxisPurity * turn.path) return;               // not one clean rotation
    const measured = unit(turn.rot).map((v) => v * turn.side);           // the direction this turn was about
    if (angleBetween(measured, wristAxis) > config.turnAxisMaxDegrees) return;
    const next = unit(wristAxis.map((v, i) => v + config.turnAxisLearn * (measured[i] - v)));
    if (angleBetween(next, calibration.twistVec) > config.turnAxisMaxDrift) return;
    wristAxis = next;
    state.axisOff = angleBetween(wristAxis, calibration.twistVec);
    state.axis = wristAxis;
  }

  /** A turn is over: if it was not a step, say why (small wobbles say nothing). */
  function endTurn() {
    learnAxis();
    const far = Math.abs(turn.angle);
    if (!turn.fired && far >= 20) {
      const limit = turn.side > 0 ? state.limitRight : state.limitLeft;
      const why = turn.left ? 'the arm was not level'
        : turn.arm > config.turnArmShare * far ? `the arm was moving: it turned ${Math.round(turn.arm)} degrees, the wrist ${Math.round(far)}`
          : far < limit ? `too small: ${Math.round(far)} of ${limit} degrees`
            : turn.peak < config.turnMinDps ? `too slow: peak ${Math.round(turn.peak)} of ${config.turnMinDps} deg/s (a slow turn is free)`
              : 'too soon after the last one';
      turnNote(turn.angle, turn.arm, why, false);
    }
    turn = null; turnQuiet = null;
  }

  /** One sample of the turn gesture. `armRate` is the turning about anything but the forearm, deg/s. */
  function turnUpdate(s, twistRate, armRate, dt, out) {
    const w = gyro(s, bias);
    const outIsRight = config.wearingArm !== 'left';                  // outward is clockwise on the right arm
    state.limitRight = outIsRight ? config.turnOutDegrees : config.turnInDegrees;
    state.limitLeft = outIsRight ? config.turnInDegrees : config.turnOutDegrees;
    state.calm = state.clutch; state.why = state.clutch ? null : 'arm not level';
    if (waiting) {                                       // a turn qualified: is it followed by a pause?
      waiting.wrist += Math.abs(twistRate) * dt;
      waiting.arm += armRate * dt;
      waiting.back += twistRate * dt;
      const paused = Math.abs(twistRate) < config.turnPauseDps && armRate < config.turnPauseDps;
      if (!paused) waiting.since = null; else if (waiting.since === null) waiting.since = s.t;
      const undone = waiting.back * waiting.side < -0.5 * Math.abs(waiting.angle);
      const why = !state.clutch ? 'the arm was not level'
        : undone ? 'turned straight back: pause at the end of a turn'
          : waiting.arm > config.turnArmShare * waiting.wrist ? `the arm was moving: it turned ${Math.round(waiting.arm)} degrees, the wrist ${Math.round(waiting.wrist)}`
            : s.t - waiting.at > config.turnPauseWaitMs ? 'no pause after the turn' : null;
      if (why) { turnNote(waiting.angle, waiting.arm, why, false); waiting = null; }
      else if (waiting.since !== null && s.t - waiting.since >= config.turnPauseMs) {
        sendTurn(s.t, waiting.side, waiting.angle + waiting.back, waiting.arm, out);
        waiting = null;
      }
    }
    if (turn && Math.sign(twistRate) === -turn.side && Math.abs(twistRate) > config.turnStartDps) endTurn();   // turned back
    if (!turn && state.clutch && Math.abs(twistRate) > config.turnStartDps) {
      turn = { side: Math.sign(twistRate), angle: 0, arm: 0, peak: 0, fired: false, left: false, rot: [0, 0, 0], path: 0 };
    }
    if (turn) {
      turn.rot = turn.rot.map((v, i) => v + w[i] * dt);                  // the whole rotation, for learning the axis
      turn.path += Math.hypot(...w) * dt;
      turn.angle += twistRate * dt;
      turn.arm += armRate * dt;
      turn.peak = Math.max(turn.peak, Math.abs(twistRate));
      if (!state.clutch) turn.left = true;
      const far = Math.abs(turn.angle), limit = turn.side > 0 ? state.limitRight : state.limitLeft;
      if (!turn.fired && !turn.left && !waiting && far >= limit && turn.peak >= config.turnMinDps
        && turn.arm <= config.turnArmShare * far && s.t >= cooldownUntil) {
        turn.fired = true;
        if (config.turnPauseMs > 0) waiting = { at: s.t, side: turn.side, angle: turn.angle, wrist: far, arm: turn.arm, back: 0, since: null };
        else sendTurn(s.t, turn.side, turn.angle, turn.arm, out);
      }
      if (Math.abs(twistRate) < config.turnEndDps) {
        if (turnQuiet === null) turnQuiet = s.t;
        if (s.t - turnQuiet >= config.turnEndMs) endTurn();
      } else turnQuiet = null;
    }
    state.roll = turn ? turn.angle : 0;
    state.moving = turn !== null || waiting !== null;
  }

  /**
   * How far a tip must go, right and left, for the centre as it is now. Outward is the easy
   * way; inward is harder, and harder still the further inward the wrist already rests.
   */
  function tiltLimits() {
    const outIsRight = config.wearingArm !== 'left';                  // outward is clockwise on the right arm
    const turnedOut = (neutral || 0) * (outIsRight ? 1 : -1);         // where the wrist rests, outward-positive, from thumb up
    const ask = (base, room) => (config.tiltRangeShare > 0
      ? Math.max(config.tiltMinDegrees, Math.min(base, config.tiltRangeShare * room)) : base);
    const out = ask(config.tiltOutDegrees, config.tiltOutRange - turnedOut);
    const inward = ask(config.tiltInDegrees, config.tiltInRange + turnedOut);
    state.limitRight = outIsRight ? out : inward;
    state.limitLeft = outIsRight ? inward : out;
  }

  function forgetCentre() {
    neutral = null; armed = false; restSince = null; beyondSince = null; tiltPeak = 0; centreCount = 0;
    state.calm = false; state.roll = 0; state.armed = false;
  }

  /**
   * One sample of the tilt gesture. `turning` is the band's whole turning speed and
   * `twistRate` the part of it about the forearm, deg/s.
   */
  function tiltUpdate(s, turning, twistRate, out) {
    const accel = [s.ax, s.ay, s.az];
    if (tiltGravity === null) tiltGravity = accel;
    else if (Math.abs(Math.hypot(...accel) - 1) <= config.tiltMaxShake) {
      tiltGravity = tiltGravity.map((g, i) => g + config.tiltSmoothing * (accel[i] - g));
    }
    if (!state.clutch) { state.why = 'arm not level'; forgetCentre(); return; }       // start again when it is
    const roll = wristRoll(tiltGravity, calibration);
    const lift = elevation(tiltGravity, calibration.twistVec);
    // A tip turns about the forearm and nothing else. Turning about anything else is the arm
    // moving, and what gravity shows meanwhile is not the wrist: forget the centre.
    const armRate = Math.sqrt(Math.max(0, turning * turning - twistRate * twistRate));
    if (armRate <= config.tiltArmDps + config.tiltArmLeak * Math.abs(twistRate)) armSince = null;
    else if (armSince === null) armSince = s.t;
    state.armRate = armRate;
    const armMoving = armSince !== null && s.t - armSince >= config.tiltArmMs;
    if (armMoving || (neutral !== null && Math.abs(lift - centreLift) > config.tiltArmDegrees)) {
      state.why = armMoving ? 'arm turning' : 'forearm raised or lowered';
      if (neutral !== null && armed && tiltPeak >= 0.6 * Math.min(state.limitRight, state.limitLeft)) {
        tiltNote(tiltPeak, 'the arm was moving: only a turn of the wrist counts', false);
      }
      forgetCentre();
      return;
    }
    if (neutral === null) {                              // the centre: the average of where the level arm holds still
      if (turning < config.settleDps) {
        if (centreCount === 0) { restSince = s.t; centreFirst = roll; centreSum = 0; }
        centreSum += wrap(roll - centreFirst); centreCount += 1;
        if (s.t - restSince >= config.settleMs) {
          neutral = wrap(centreFirst + centreSum / centreCount);
          centreLift = lift; armed = true; restSince = null;
          tiltLimits();
        }
      } else { centreCount = 0; state.why = 'not still yet'; }
      state.calm = neutral !== null; state.roll = 0;
      return;
    }
    const resting = turning < config.tiltRestDps;
    if (resting) { if (restSince === null) restSince = s.t; } else restSince = null;
    if (restSince !== null && s.t - restSince >= config.tiltRecentreMs * (armed ? 1 : 2)) {
      neutral = roll; centreLift = lift; armed = true; beyondSince = null; tiltPeak = 0;   // resting somewhere new: the centre now
    }
    let off = wrap(roll - neutral), far = Math.abs(off);
    tiltLimits();
    if (armed && resting && far <= Math.min(config.tiltReturnDegrees, 0.6 * state.limitRight, 0.6 * state.limitLeft)) {
      neutral = wrap(neutral + off * config.tiltCentreFollow);        // resting near the centre: the centre follows
      off = wrap(roll - neutral); far = Math.abs(off);
    }
    const limit = off > 0 ? state.limitRight : state.limitLeft;
    const back = Math.min(config.tiltReturnDegrees, 0.6 * limit);
    if (!armed) {
      if (far <= back) { armed = true; tiltPeak = 0; beyondSince = null; }
    } else {
      if (far > tiltPeak) { tiltPeak = far; state.peakLimit = limit; }
      if (far >= limit) {
        if (beyondSince === null) beyondSince = s.t;
        if (s.t - beyondSince >= config.tiltHoldMs && s.t >= cooldownUntil) {
          const side = off > 0 ? 1 : -1;
          out.push({ type: 'step', direction: side });
          cooldownUntil = s.t + config.cooldownMs;
          armed = false;
          tiltNote(off, side > 0 ? 'Right' : 'Left', true);
        }
      } else {
        beyondSince = null;
        if (far <= back) {
          if (tiltPeak >= 0.6 * state.peakLimit) {
            tiltNote(tiltPeak, `tipped ${Math.round(tiltPeak)} of ${Math.round(state.peakLimit)} degrees`, false);
          }
          tiltPeak = 0;
        }
      }
    }
    state.calm = true; state.roll = off; state.armed = armed; state.why = null; state.centre = neutral;
  }

  /** Write down how the movement was judged, for the page. */
  function report(winner, result, counted) {
    state.movement = { swipe: move.swipeSum, twist: move.twistSum, winner, result, counted };
    state.missed = counted ? null : result;
  }

  const one = () => config.gestures === 'leftRight';
  const sideName = (side) => (one() ? (side > 0 ? 'Right' : 'Left') : (side > 0 ? 'Swipe right' : 'Swipe left'));
  const isReturn = (side, start) => side === -lastTwist.side && start - lastTwist.endedAt < config.returnMs;

  function classify() {
    const { swipeSum, twistSum } = move;
    const ratio = one() ? 1 : config.dominanceRatio;     // one motion: the stronger axis simply gives the direction
    if (swipeSum >= ratio * twistSum) {
      move.side = move.swipeNet < 0 ? -1 : 1;
      if (one() && isReturn(move.side, move.start)) {
        move.phase = 'ignored';                          // coming back after a counted motion is free
        lastTwist = { side: 0, endedAt: -Infinity };
        report('swipe', 'coming back after the last one', false);
      } else {
        move.phase = 'swipe';
        report('swipe', one() ? 'a sweep, not finished yet' : 'a swipe, not finished yet', true);
      }
    } else if (twistSum >= ratio * swipeSum) {
      move.side = move.turned < 0 ? -1 : 1;
      if (isReturn(move.side, move.start)) {
        move.phase = 'ignored';                          // turning back after a twist is free
        lastTwist = { side: 0, endedAt: -Infinity };
        report('twist', one() ? 'coming back after the last one' : 'turning back after the last twist', false);
      } else {
        move.phase = 'twist';
        report('twist', one() ? 'a turn of the wrist, not far enough yet' : 'a twist', true);
      }
    } else {
      move.phase = 'ignored';
      report('none', 'no clear winner: neither axis did ' + config.dominanceRatio + ' times the other', false);
    }
  }

  /** The sweep on the swipe axis has stopped: was it a swipe? */
  function finishSwipe(t, out) {
    const ms = t - move.start;
    if (ms > config.swipeMaxMs) report('swipe', `too long: ${Math.round(ms)} ms (a swipe is over within ${config.swipeMaxMs})`, false);
    else if (move.swipePeak < swipeMin) {
      report('swipe', `too gentle: peak ${Math.round(move.swipePeak)} of ${Math.round(swipeMin)} deg/s`, false);
    } else if (Math.abs(move.swipeNet) < config.swipeMinDegrees) {
      report('swipe', `too short a sweep: ${Math.round(Math.abs(move.swipeNet))} of ${config.swipeMinDegrees} degrees`, false);
    } else {
      out.push({ type: 'step', direction: move.side });
      cooldownUntil = t + config.cooldownMs;
      if (one()) move.stepped = true;
      report('swipe', sideName(move.side), true);
    }
    move.phase = 'ignored';
  }

  function endMove(t) {
    if (move && ((move.phase === 'twist' && move.steps > 0) || move.stepped)) {
      cooldownUntil = t + config.cooldownMs;
      lastTwist = { side: move.side, endedAt: t };       // moving back the other way soon after is the return
    }
    move = null;
  }

  function update(s) {
    const out = [];
    const dt = lastT === null ? 0 : Math.max(0, Math.min(0.05, (s.t - lastT) / 1000));
    lastT = s.t;
    const accel = [s.ax, s.ay, s.az];
    // A quick turn throws the band about: its acceleration is then not gravity. Leave those samples out,
    // or the arm seems to leave the level pose in the middle of a turn.
    const jolted = Math.abs(Math.hypot(...accel) - 1) > config.tiltMaxShake;
    if (gravity === null) gravity = accel;
    else if (!jolted) gravity = gravity.map((g, i) => g + config.gravitySmoothing * (accel[i] - g));
    up = up === null ? accel : up.map((g, i) => g + config.upSmoothing * (accel[i] - g));
    const turnMode = config.gestures === 'turn';
    state.angle = clutchAngle(gravity, turnMode ? { ...calibration, twistVec: wristAxis } : calibration, config);
    state.clutch = state.angle <= config.clutchDegrees;
    state.swipeMin = swipeMin = swipeThreshold(calibration, config);

    // Calm: level and hardly turning about any direction. A gesture has to start from there.
    const turning = Math.hypot(...gyro(s, bias));
    if (state.clutch && turning < config.settleDps) {
      if (calmSince === null) calmSince = s.t;
      calmFor = s.t - calmSince;
      calmEndedAt = s.t;
    } else calmSince = null;
    const settled = config.settleMs <= 0 || (calmFor >= config.settleMs && s.t - calmEndedAt <= config.settleGraceMs);
    state.calm = settled;

    const twistRate = rateAbout(s, turnMode ? wristAxis : calibration.twistVec, bias);   // clockwise-positive
    const swipeRate = config.swipeAxis === 'calibrated'                    // right-positive
      ? rateAbout(s, calibration.swipeVec, bias)
      : rateAbout(s, sidewaysAxis(up, calibration.twistVec), bias) * (calibration.swipeSign || 1);
    const still = Math.abs(twistRate) < config.stillDps && Math.abs(swipeRate) < config.stillDps;
    if (!still) stillSince = null; else if (stillSince === null) stillSince = s.t;

    if (toggleAt !== null && s.t >= toggleAt) {          // no double-tap came: the tap was a toggle
      toggleAt = null;
      out.push({ type: 'toggle' });
      cooldownUntil = s.t + config.cooldownMs;
    }

    if (config.gestures === 'turn') {
      move = null;
      turnUpdate(s, twistRate, Math.sqrt(Math.max(0, turning * turning - twistRate * twistRate)), dt, out);
      state.twisting = false; state.twistRate = twistRate; state.swipeRate = swipeRate;
      return out;
    }

    if (config.gestures === 'tilt') {
      move = null;
      tiltUpdate(s, turning, twistRate, out);
      state.twisting = false; state.moving = false; state.twistRate = twistRate; state.swipeRate = swipeRate;
      return out;
    }

    if (!state.clutch) endMove(s.t);
    else if (!move) {
      if (settled && s.t >= cooldownUntil && (Math.abs(twistRate) > config.moveStartDps || Math.abs(swipeRate) > config.moveStartDps)) {
        move = { start: s.t, phase: 'compare', swipeSum: 0, twistSum: 0, swipeNet: 0, swipePeak: 0, turned: 0, steps: 0, side: 0 };
      }
    }

    if (move) {
      move.turned += twistRate * dt;
      if (move.phase === 'compare') {
        move.swipeSum += Math.abs(swipeRate) * dt;
        move.twistSum += Math.abs(twistRate) * dt;
        move.swipeNet += swipeRate * dt;
        move.swipePeak = Math.max(move.swipePeak, Math.abs(swipeRate));
        // Decide when the comparison time is up, or sooner if the movement is already over.
        const slowed = Math.abs(twistRate) < config.moveStartDps && Math.abs(swipeRate) < config.moveStartDps;
        if (s.t - move.start >= config.classifyMs || (slowed && s.t > move.start)) {
          classify();
          if (move.phase === 'swipe' && slowed) finishSwipe(s.t, out);
        }
      } else if (move.phase === 'swipe') {
        move.swipeNet += swipeRate * dt;
        move.swipePeak = Math.max(move.swipePeak, Math.abs(swipeRate));
        if (Math.abs(swipeRate) < config.moveStartDps || Math.sign(swipeRate) !== move.side) finishSwipe(s.t, out);
        else if (s.t - move.start > config.swipeMaxMs) {
          report('swipe', `too long: more than ${config.swipeMaxMs} ms on the swipe axis`, false);
          move.phase = 'ignored';
        }
      } else if (move.phase === 'twist') {
        const far = move.turned * move.side;             // degrees turned in the twist's own direction
        const steps = far < config.twistStartDegrees ? 0 : 1 + Math.floor((far - config.twistStartDegrees) / config.twistStepDegrees);
        if (one()) {                                     // one motion: far enough is one step, and that is all
          if (steps > 0 && move.steps === 0) {
            out.push({ type: 'step', direction: move.side });
            move.steps = 1;
            report('twist', sideName(move.side), true);
          }
        } else {
          while (move.steps < steps) {                   // further than before: one adjust per step
            out.push({ type: 'adjust', delta: move.side * config.adjustStep });
            move.steps += 1;
          }
          if (move.steps > 0) report('twist', move.side > 0 ? 'Twist clockwise' : 'Twist counter-clockwise', true);
        }
      }
      if (stillSince !== null && s.t - stillSince >= config.stillMs) {     // the arm is still: the movement is over
        if (move.phase === 'twist' && move.steps === 0) {
          report('twist', `too small: ${Math.round(Math.abs(move.turned))} of ${config.twistStartDegrees} degrees`, false);
        }
        endMove(s.t);
      }
    }

    state.twisting = move !== null && move.phase === 'twist';
    state.moving = move !== null;
    state.roll = move ? move.turned : 0;
    state.twistRate = twistRate;
    state.swipeRate = swipeRate;
    return out;
  }

  function tap(kind, t) {
    const twisting = move !== null && move.phase === 'twist' && move.steps > 0;
    if (move && (move.phase === 'compare' || move.phase === 'swipe')) {
      report(move.phase === 'swipe' ? 'swipe' : 'none', 'the band was tapped: that jolt is not a gesture', false);
      move.phase = 'ignored';                            // a tap shakes the band: not a swipe
    }
    if (kind === 'double-tap') {
      const held = toggleAt !== null;
      toggleAt = null;                                   // the tap before it was not a toggle
      if (twisting || (t < cooldownUntil && !held)) return [];
      cooldownUntil = t + config.cooldownMs;
      return [{ type: 'select' }];
    }
    if (twisting || t < cooldownUntil || toggleAt !== null) return [];
    if (config.tapBeforeDoubleTap) { toggleAt = t + config.tapDelayMs; return []; }
    cooldownUntil = t + config.cooldownMs;
    return [{ type: 'toggle' }];
  }

  return { update, tap, state };
}
