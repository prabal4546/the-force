// Tests for gestures.js with synthetic samples: no band needed.  Run: npm test
//
// The pretend wrist: the forearm lies along x, level gravity is on z. Rolling the wrist by
// `roll` degrees turns gravity about x and shows on gx; a swipe (the forearm sweeping sideways) shows on gz only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFIG, angleBetween, checkPose, computeCalibration, clutchAngle, createDetector, swipeThreshold, wristRoll,
} from '../gestures.js';

// Most of this file tests the two-gesture mode; the one-motion mode (the default) is at the end.
const DEFAULT_GESTURES = CONFIG.gestures;
CONFIG.gestures = 'twistAndSwipe';

const STEP = 10;                                   // ms between samples: 100 a second
const RAD = Math.PI / 180;
const HANGING = { ax: 1, ay: 0, az: 0 };           // arm at the side: gravity along the forearm

/**
 * `ms` of samples from `t0`. `roll(seconds)` is the wrist angle in degrees (clockwise);
 * `extra(seconds)` gives fields to override. `mirror` flips how gravity turns, as on a band
 * worn the other way round.
 */
function wrist(t0, ms, roll = () => 0, extra = () => ({}), mirror = 1) {
  const out = [];
  for (let t = 0; t < ms; t += STEP) {
    const s = t / 1000, r = roll(s), rate = (roll(s + 0.001) - roll(s - 0.001)) / 0.002;
    out.push({ t: t0 + t, ax: 0, ay: mirror * Math.sin(r * RAD), az: Math.cos(r * RAD), gx: rate, gy: 0, gz: 0, ...extra(s) });
  }
  return out;
}
const hold = (t0, ms, angle = 0, pose = {}) => wrist(t0, ms, () => angle, () => pose);
/** Turn from one angle to another at a steady speed (deg/s); returns the samples and the end time. */
function turn(t0, from, to, speed, mirror = 1) {
  const ms = Math.round(Math.abs(to - from) / speed * 100) * 10;
  return wrist(t0, ms, (s) => from + Math.sign(to - from) * speed * s, undefined, mirror);
}
const swipe = (t0, ms, dps, twistDps = 0) => wrist(t0, ms, () => 0, () => ({ gz: dps, gx: twistDps }));

const swing = (peak) => (s) => peak * Math.sin(2 * Math.PI * 1.5 * s + 0.3);          // degrees, clockwise first
const swipePose = (peak) => wrist(0, 2000, () => 0, (s) => ({ gz: peak * Math.sin(2 * Math.PI * 1.5 * s + 0.3) }));
const CAL = computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40)), swipePose(500));

/** Run samples through a fresh detector (or the one given); returns every message. */
function run(list, detector = createDetector(CAL)) {
  return list.flatMap((s) => detector.update(s));
}
const adjusts = (n, delta) => Array(n).fill({ type: 'adjust', delta });

test('calibration finds gravity, the axes, the gyro bias and the swipe strength', () => {
  assert.equal(CAL.twistAxis, 'gx');
  assert.equal(CAL.swipeAxis, 'gz');
  assert.ok(angleBetween(CAL.gravity, [0, 0, 1]) < 1);
  assert.ok(CAL.twistVec[0] > 0.99, 'twist direction is +x: clockwise first');
  assert.ok(Math.abs(CAL.swipeVec[2]) > 0.99, 'the swipe pose turned about z');
  assert.equal(CAL.swipeSign, 1);
  assert.ok(Math.abs(CAL.bias.gx) < 1);
  assert.ok(CAL.swipePeak > 450 && CAL.swipePeak <= 500);
});

test('calibration refuses a swipe that goes up and down instead of sideways', () => {
  const upDown = wrist(0, 2000, () => 0, (s) => ({ gy: 300 * Math.sin(9 * s) }));       // level arm, turning about y
  assert.throws(() => computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40)), upDown), /up and down/);
  assert.match(checkPose('swipe', upDown, { level: hold(0, 2000), twist: wrist(0, 2000, swing(40)) }), /up and down/);
});

test('calibration refuses a pose that did not move', () => {
  assert.throws(() => computeCalibration(hold(0, 2000), hold(0, 2000), swipePose(500)), /twist pose/);
});

test('a gentle swipe in calibration lowers the swipe threshold, but not below the floor', () => {
  assert.equal(swipeThreshold({ ...CAL, swipePeak: 700 }), 250);
  assert.equal(swipeThreshold({ ...CAL, swipePeak: 400 }), 200);
  assert.equal(swipeThreshold({ ...CAL, swipePeak: 200 }), 150);
});

test('twist: turning 65 degrees away gives four adjusts, and turning back gives nothing', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, 65, 130), ...hold(1000, 200, 65), ...turn(1200, 65, 0, 130), ...hold(1700, 800)]);
  assert.deepEqual(out, adjusts(4, 0.05));
});

test('twist the other way gives negative adjusts, and again nothing on the way back', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, -50, 100), ...turn(1000, -50, 0, 100), ...hold(1500, 800)]);
  assert.deepEqual(out, adjusts(3, -0.05));
});

test('twist works the same on a band whose gravity turns the other way', () => {
  const cal = computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40), undefined, -1), swipePose(500));
  const out = run([...hold(0, 500), ...turn(500, 0, 65, 130, -1), ...turn(1000, 65, 0, 130, -1), ...hold(1500, 800)], createDetector(cal));
  assert.deepEqual(out, adjusts(4, 0.05));
});

test('pausing at the far end still gives a free return', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, 50, 100), ...hold(1000, 700, 50), ...turn(1700, 50, 0, 100), ...hold(2200, 800)]);
  assert.deepEqual(out, adjusts(3, 0.05));
});

test('turning further after a pause is a new twist: it has to pass its own starting angle', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, 35, 100), ...hold(850, 600, 35), ...turn(1450, 35, 65, 100), ...hold(1750, 300, 65)]);
  assert.deepEqual(out, adjusts(3, 0.05));                              // two for the 35 degrees, one for the 30 more
});

test('a twist that never comes back does not block swipes and taps', () => {
  const detector = createDetector(CAL);
  assert.equal(run([...hold(0, 500), ...turn(500, 0, 50, 100), ...hold(1000, 1500, 50)], detector).length, 3);
  assert.equal(detector.state.twisting, false);
  const pose = (t, ms, gz) => wrist(t, ms, () => 50, () => ({ gz }));
  assert.deepEqual(run([...pose(2500, 100, 400), ...pose(2600, 700, 0)], detector), [{ type: 'step', direction: 1 }]);
  assert.deepEqual(detector.tap('double-tap', 3300), [{ type: 'select' }]);
});

test('calibration poses are checked one at a time', () => {
  const level = hold(0, 2000), twist = wrist(0, 2000, swing(40));
  assert.equal(checkPose('level', level), null);
  assert.match(checkPose('level', twist), /moving/);
  assert.equal(checkPose('twist', twist, { level }), null);
  assert.match(checkPose('twist', level, { level }), /hardly moved/);
  assert.equal(checkPose('swipe', swipePose(500), { level, twist }), null);
  assert.match(checkPose('swipe', twist, { level, twist }), /mostly a twist/);
});

test('cranking twice adds up', () => {
  const once = (t) => [...turn(t, 0, 50, 100), ...turn(t + 500, 50, 0, 100), ...hold(t + 1000, 1000)];
  assert.deepEqual(run([...hold(0, 500), ...once(500), ...once(2500)]), adjusts(6, 0.05));
});

test('a slow drift of the wrist is not a twist', () => {
  assert.deepEqual(run([...hold(0, 500), ...turn(500, 0, 40, 10), ...hold(4500, 500, 40)]), []);
});

test('turning the wrist does not open the clutch', () => {
  const detector = createDetector(CAL);
  run([...hold(0, 500), ...turn(500, 0, 70, 100), ...hold(1200, 300, 70)], detector);
  assert.equal(detector.state.clutch, true);
  assert.ok(clutchAngle([0, Math.sin(1.2), Math.cos(1.2)], CAL) < 1);
});

test('nothing fires while the arm hangs at the side', () => {
  const list = [
    ...hold(0, 500, 0, HANGING),
    ...wrist(500, 1000, () => 0, () => ({ ...HANGING, gx: 200 })),      // would be a twist
    ...wrist(1500, 100, () => 0, () => ({ ...HANGING, gz: 400 })),      // would be a swipe
    ...hold(1600, 500, 0, HANGING),
  ];
  const detector = createDetector(CAL);
  assert.deepEqual(run(list, detector), []);
  assert.equal(detector.state.clutch, false);
});

test('swipe: a 100 ms sweep gives one step, and the swing back is inside the cooldown', () => {
  const out = run([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 50), ...swipe(450, 100, -400), ...hold(550, 600)]);
  assert.deepEqual(out, [{ type: 'step', direction: 1 }]);
});

test('swipe the other way gives direction -1', () => {
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 80, -500), ...hold(380, 300)]), [{ type: 'step', direction: -1 }]);
});

test('a sweep longer than 350 ms is not a swipe, and says why', () => {
  const detector = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 450, 300), ...hold(750, 300)], detector), []);
  assert.match(detector.state.missed, /too long: more than 350 ms/);
  assert.equal(detector.state.movement.counted, false);
});

test('a movement with as much twist as swipe in it is neither', () => {
  const detector = createDetector(CAL);
  const out = run([...hold(0, 300), ...swipe(300, 100, 400, 350), ...hold(400, 300)], detector);
  assert.ok(out.every((m) => m.type !== 'step'));
  assert.match(detector.state.missed, /no clear winner/);
});

test('a swipe that leaks onto the twist axis is one step and no adjust', () => {
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 400, 200), ...hold(400, 600)]), [{ type: 'step', direction: 1 }]);
});

test('a gentle wearer gets a lower threshold from calibration', () => {
  const gentle = { ...CAL, swipePeak: 360 };                            // threshold 180
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 220), ...hold(400, 300)]), []);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 220), ...hold(400, 300)], createDetector(gentle)), [{ type: 'step', direction: 1 }]);
});

test('a tap alone becomes toggle after the delay', () => {
  const detector = createDetector(CAL);
  run(hold(0, 300), detector);
  assert.deepEqual(detector.tap('tap', 300), []);
  assert.deepEqual(run(hold(300, 290), detector), []);
  assert.deepEqual(run(hold(590, 100), detector), [{ type: 'toggle' }]);
});

test('a tap followed by a double-tap is one select and no toggle', () => {
  const detector = createDetector(CAL);
  run(hold(0, 300), detector);
  detector.tap('tap', 300);
  assert.deepEqual(detector.tap('double-tap', 450), [{ type: 'select' }]);
  assert.deepEqual(run(hold(300, 1000), detector), []);
});

test('with no tap before double-taps, toggle fires at once', () => {
  const detector = createDetector(CAL, { ...CONFIG, tapBeforeDoubleTap: false });
  run(hold(0, 300), detector);
  assert.deepEqual(detector.tap('tap', 300), [{ type: 'toggle' }]);
});

test('one gesture at a time: a tap during the cooldown after a swipe is dropped', () => {
  const detector = createDetector(CAL);
  assert.equal(run([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 20)], detector).length, 1);
  assert.deepEqual(detector.tap('tap', 500), []);
  assert.deepEqual(run(hold(420, 1500), detector), []);
});

test('a twist ends with a cooldown: a swipe right after it is dropped, a later one counts', () => {
  const detector = createDetector(CAL);
  assert.equal(run([...hold(0, 500), ...turn(500, 0, 35, 100), ...turn(850, 35, 0, 100), ...hold(1200, 100)], detector).length, 2);
  assert.deepEqual(run([...swipe(1300, 100, 400), ...hold(1400, 800)], detector), []);
  assert.deepEqual(run([...swipe(2200, 100, 400), ...hold(2300, 100)], detector), [{ type: 'step', direction: 1 }]);
});

/** The same motion as seen by a band that sits turned on the wrist: every reading rotated. */
function turned(list) {
  const a = 35 * RAD, b = 20 * RAD;                // 35 degrees about z, then 20 about x
  const rot = (v) => {
    const x1 = v[0] * Math.cos(a) - v[1] * Math.sin(a), y1 = v[0] * Math.sin(a) + v[1] * Math.cos(a);
    return [x1, y1 * Math.cos(b) - v[2] * Math.sin(b), y1 * Math.sin(b) + v[2] * Math.cos(b)];
  };
  return list.map((s) => {
    const acc = rot([s.ax, s.ay, s.az]), gyr = rot([s.gx, s.gy, s.gz]);
    return { t: s.t, ax: acc[0], ay: acc[1], az: acc[2], gx: gyr[0], gy: gyr[1], gz: gyr[2] };
  });
}

test('a band that sits crooked on the wrist: twist and swipe are still told apart', () => {
  const cal = computeCalibration(turned(hold(0, 2000)), turned(wrist(0, 2000, swing(40))), turned(swipePose(500)));
  const twist = run(turned([...hold(0, 500), ...turn(500, 0, 65, 130), ...turn(1000, 65, 0, 130), ...hold(1500, 800)]), createDetector(cal));
  assert.deepEqual(twist, adjusts(4, 0.05));
  const other = run(turned([...hold(0, 500), ...turn(500, 0, -50, 100), ...turn(1000, -50, 0, 100), ...hold(1500, 800)]), createDetector(cal));
  assert.deepEqual(other, adjusts(3, -0.05));
  assert.deepEqual(run(turned([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 600)]), createDetector(cal)), [{ type: 'step', direction: 1 }]);
  assert.deepEqual(run(turned([...hold(0, 300), ...swipe(300, 100, -400), ...hold(400, 600)]), createDetector(cal)), [{ type: 'step', direction: -1 }]);
});

test('a swipe of 250 ms above the threshold still counts', () => {
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 250, 400), ...hold(550, 600)]), [{ type: 'step', direction: 1 }]);
});

test('a movement that is not counted says why', () => {
  const detector = createDetector(CAL);
  const noisy = wrist(500, 500, (s) => 100 * s, () => ({ gz: 200 }));          // turning with more swipe than twist in it
  assert.deepEqual(run([...hold(0, 500), ...noisy, ...hold(1000, 300, 50)], detector), []);
  assert.equal(detector.state.movement.winner, 'swipe');
  assert.match(detector.state.missed, /too long/);

  const small = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 500), ...turn(500, 0, 15, 100), ...hold(650, 500, 15)], small), []);
  assert.equal(small.state.missed, 'too small: 15 of 20 degrees');

  const gentle = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 200), ...hold(400, 300)], gentle), []);
  assert.match(gentle.state.missed, /too gentle: peak 200 of 2\d\d deg/);
});

test('a counted gesture is named for the page, and clears the reason', () => {
  const detector = createDetector(CAL);
  run([...hold(0, 300), ...swipe(300, 100, -400), ...hold(400, 300)], detector);
  assert.equal(detector.state.movement.result, 'Swipe left');
  assert.equal(detector.state.movement.counted, true);
  assert.equal(detector.state.missed, null);
});

test('a tap during a sweep cancels the swipe', () => {
  const detector = createDetector(CAL);
  const list = [...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 300)];
  const out = [];
  for (const s of list) { if (s.t === 350) detector.tap('tap', 350); out.push(...detector.update(s)); }
  assert.ok(out.every((m) => m.type !== 'step'));
  assert.match(detector.state.missed, /tapped/);
});

test('the calibrated swipe axis can be used instead of the vertical', () => {
  const config = { ...CONFIG, swipeAxis: 'calibrated' };
  const detector = createDetector(computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40)), swipePose(500), config), config);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 300)], detector), [{ type: 'step', direction: 1 }]);
});

/** A sideways swipe (turning about the vertical) with the wrist held rolled by `roll` degrees. */
function swipeAt(roll, t0, ms, dps) {
  return wrist(t0, ms, () => roll, () => ({ gy: dps * Math.sin(roll * RAD), gz: dps * Math.cos(roll * RAD) }));
}

test('a sideways swipe counts however the wrist is rolled: palm down, thumb up, in between', () => {
  for (const roll of [0, 45, 90, -60]) {
    const right = run([...hold(0, 600, roll), ...swipeAt(roll, 600, 100, 400), ...hold(700, 500, roll)]);
    assert.deepEqual(right, [{ type: 'step', direction: 1 }], 'right at roll ' + roll);
    const left = run([...hold(0, 600, roll), ...swipeAt(roll, 600, 100, -400), ...hold(700, 500, roll)]);
    assert.deepEqual(left, [{ type: 'step', direction: -1 }], 'left at roll ' + roll);
  }
});

test('an up-and-down swipe is not a step', () => {
  const upDown = wrist(600, 100, () => 0, () => ({ gy: 400 }));
  assert.deepEqual(run([...hold(0, 600), ...upDown, ...hold(700, 500)]), []);
});

test('gestures work with the forearm tilted 40 degrees up or down, and stop near vertical', () => {
  const tilt = (deg) => ({ ax: Math.sin(deg * RAD), az: Math.cos(deg * RAD) });
  for (const deg of [40, -40]) {
    const pose = tilt(deg);
    const out = run([...wrist(0, 600, () => 0, () => pose), ...wrist(600, 100, () => 0, () => ({ ...pose, gy: 0, gz: 400 * Math.cos(deg * RAD), gx: 400 * Math.sin(deg * RAD) * 0 })), ...wrist(700, 500, () => 0, () => pose)]);
    assert.equal(out.length, 1, 'swipe at tilt ' + deg);
  }
  const steep = tilt(70);
  assert.deepEqual(run([...wrist(0, 600, () => 0, () => steep), ...wrist(600, 100, () => 0, () => ({ ...steep, gz: 400 })), ...wrist(700, 500, () => 0, () => steep)]), []);
});

// ---- Ghosts: movement that was never meant as a gesture ----

/** The arm on the move without twisting or sweeping: turning about y, as when reaching. */
const reach = (t0, ms) => wrist(t0, ms, () => 0, () => ({ gy: 200 }));

test('a swipe straight out of other movement is not counted: gestures start from a calm arm', () => {
  const detector = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 300), ...reach(300, 300), ...swipe(600, 100, 400), ...hold(700, 500)], detector), []);
  assert.deepEqual(run([...swipe(1200, 100, 400), ...hold(1300, 300)], detector), [{ type: 'step', direction: 1 }]);
});

test('the same for a twist, and the page can tell when the arm is calm', () => {
  const detector = createDetector(CAL);
  run([...hold(0, 300), ...reach(300, 300)], detector);
  assert.equal(detector.state.calm, false);
  assert.deepEqual(run([...turn(600, 0, 50, 100), ...hold(1100, 500, 50)], detector), []);
  assert.equal(detector.state.calm, true);
});

test('settleMs 0 turns the calm check off', () => {
  const detector = createDetector(CAL, { ...CONFIG, settleMs: 0 });
  const out = run([...hold(0, 300), ...reach(300, 300), ...swipe(600, 100, 400), ...hold(700, 500)], detector);
  assert.deepEqual(out, [{ type: 'step', direction: 1 }]);
});

test('a jolt is fast but goes nowhere: not a swipe, and it says why', () => {
  const detector = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 20, 500), ...hold(320, 400)], detector), []);
  assert.match(detector.state.missed, /too short a sweep: 10 of 12 degrees/);
});

test('thresholds can be changed while the detector runs', () => {
  const config = { ...CONFIG };
  const detector = createDetector(CAL, config);
  const sweep = (t, dps) => [...swipe(t, 100, dps), ...hold(t + 100, 900)];
  assert.deepEqual(run([...hold(0, 300), ...sweep(300, 180)], detector), []);          // under the calibrated 249
  config.swipeMinDps = 150;                                             // lowered: takes effect at once
  assert.deepEqual(run(sweep(1300, 180), detector), [{ type: 'step', direction: 1 }]);
  config.swipeMinDps = 400;                                             // raised: the calibrated 249 is still lower
  assert.deepEqual(run(sweep(2300, 300), detector), [{ type: 'step', direction: 1 }]);
  config.swipeFromCalibration = false;                                  // tuned by hand: swipeMinDps alone decides
  assert.equal(swipeThreshold(CAL, config), 400);
  assert.deepEqual(run(sweep(3300, 300), detector), []);
  assert.equal(detector.state.swipeMin, 400);
});

// ---- One motion: left and right (the default) ----

const ONE = { ...CONFIG, gestures: 'leftRight' };
const one = () => createDetector(CAL, ONE);
const RIGHT = [{ type: 'step', direction: 1 }], LEFT = [{ type: 'step', direction: -1 }];

test('one motion: a sweep to the right or left is one step', () => {
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 400)], one()), RIGHT);
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, -400), ...hold(400, 400)], one()), LEFT);
});

test('one motion: turning the wrist is the same gesture, one step however far it turns', () => {
  const detector = one();
  assert.deepEqual(run([...hold(0, 500), ...turn(500, 0, 65, 130), ...hold(1000, 400, 65)], detector), RIGHT);
  assert.equal(detector.state.movement.result, 'Right');
  assert.deepEqual(run([...hold(0, 500), ...turn(500, 0, -50, 100), ...hold(1000, 400, -50)], one()), LEFT);
});

test('one motion: never an adjust, and a mixed movement still counts, by its stronger axis', () => {
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 400, 350), ...hold(400, 400)], one()), RIGHT);
  const mostlyTwist = wrist(500, 500, (s) => 100 * s, () => ({ gz: -60 }));            // clockwise, drifting left a little
  assert.deepEqual(run([...hold(0, 500), ...mostlyTwist, ...hold(1000, 400, 50)], one()), RIGHT);
});

test('one motion: coming back is free, in the same movement or soon after', () => {
  const same = run([...hold(0, 300), ...swipe(300, 100, 400), ...swipe(400, 100, -400), ...hold(500, 700)], one());
  assert.deepEqual(same, RIGHT);
  const detector = one();
  const after = run([...hold(0, 300), ...swipe(300, 100, 400), ...hold(400, 700), ...swipe(1100, 100, -400), ...hold(1200, 700)], detector);
  assert.deepEqual(after, RIGHT);
  assert.match(detector.state.missed, /coming back/);
  const twist = run([...hold(0, 500), ...turn(500, 0, 50, 100), ...hold(1000, 700, 50), ...turn(1700, 50, 0, 100), ...hold(2200, 800)], one());
  assert.deepEqual(twist, RIGHT);
});

test('one motion: the same way twice is two steps, and so is the other way after a wait', () => {
  const sweep = (t, dps) => [...swipe(t, 100, dps), ...hold(t + 100, 1900)];
  assert.deepEqual(run([...hold(0, 300), ...sweep(300, 400), ...sweep(2300, 400)], one()), [...RIGHT, ...RIGHT]);
  assert.deepEqual(run([...hold(0, 300), ...sweep(300, 400), ...sweep(2300, -400)], one()), [...RIGHT, ...LEFT]);
});

test('one motion: too gentle or too small is nothing, and says why', () => {
  const detector = one();
  assert.deepEqual(run([...hold(0, 300), ...swipe(300, 100, 200), ...hold(400, 400)], detector), []);
  assert.match(detector.state.missed, /too gentle/);
  assert.deepEqual(run([...hold(0, 500), ...turn(500, 0, 15, 100), ...hold(650, 500, 15)], one()), []);
});

test('one motion: taps still work, and nothing fires with the arm hanging', () => {
  const detector = one();
  run(hold(0, 300), detector);
  detector.tap('tap', 300);
  assert.deepEqual(detector.tap('double-tap', 450), [{ type: 'select' }]);
  const hanging = [...hold(0, 500, 0, HANGING), ...wrist(500, 100, () => 0, () => ({ ...HANGING, gz: 400 })), ...hold(600, 500, 0, HANGING)];
  assert.deepEqual(run(hanging, one()), []);
});

// ---- Tilt: tip the wrist right or left and come back (the default) ----

// Same distance both ways and no look at the room left, so these tests are about the mechanics; the anatomy is at the end.
const TILT = { ...CONFIG, gestures: 'tilt', tiltOutDegrees: 30, tiltInDegrees: 30, tiltRangeShare: 0 };
const tilt = (cal = CAL) => createDetector(cal, TILT);
/** Hold at `from`, tip to `to` at 200 deg/s, hold there `stay` ms, come back, hold. */
function tip(t0, from, to, stay = 300) {
  const out = [...hold(t0, 500, from)];
  let t = t0 + 500;
  const there = turn(t, from, to, 200); out.push(...there); t += there.length * STEP;
  out.push(...hold(t, stay, to)); t += stay;
  const back = turn(t, to, from, 200); out.push(...back); t += back.length * STEP;
  return [...out, ...hold(t, 600, from)];
}

test('the wrist angle is read from gravity, clockwise-positive', () => {
  assert.ok(Math.abs(wristRoll([0, Math.sin(40 * RAD), Math.cos(40 * RAD)], CAL) - 40) < 0.5);
  assert.ok(Math.abs(wristRoll([0, -Math.sin(70 * RAD), Math.cos(70 * RAD)], CAL) + 70) < 0.5);
  assert.equal(CAL.rollSign, 1);
});

test('tilt: tip right and come back is one step right; coming back sends nothing', () => {
  const detector = tilt();
  assert.deepEqual(run(tip(0, 0, 45), detector), RIGHT);
  assert.equal(detector.state.movement.result, 'Right');
  assert.deepEqual(run(tip(0, 0, -45), tilt()), LEFT);
});

test('tilt: right, back, right again is two steps; right then left is one of each', () => {
  const detector = tilt();
  const first = tip(0, 0, 45), t = first[first.length - 1].t + STEP;
  assert.deepEqual(run([...first, ...tip(t, 0, 45)], detector), [...RIGHT, ...RIGHT]);
  assert.deepEqual(run([...first, ...tip(t, 0, -45)], tilt()), [...RIGHT, ...LEFT]);
});

test('tilt: tipped only part of the way is nothing, and says how far', () => {
  const detector = tilt();
  assert.deepEqual(run(tip(0, 0, 22), detector), []);
  assert.match(detector.state.missed, /tipped 2\d of 30 degrees/);
});

test('tilt: the centre is wherever the level arm rests: palm down works like thumb up', () => {
  assert.deepEqual(run(tip(0, 90, 135), tilt()), RIGHT);
  assert.deepEqual(run(tip(0, -60, -105), tilt()), LEFT);
});

test('tilt: staying tipped for a second and coming back is still one step', () => {
  assert.deepEqual(run(tip(0, 0, 45, 1000), tilt()), RIGHT);
});

test('tilt: resting somewhere new makes that the centre, with no step for getting there slowly', () => {
  const detector = tilt();
  const drift = [...hold(0, 500), ...turn(500, 0, 25, 10), ...hold(3000, 2000, 25)];       // 25 degrees over 2.5 s, then rest
  assert.deepEqual(run(drift, detector), []);
  assert.deepEqual(run(tip(5000, 25, 60), detector), RIGHT);                             // 35 from the new centre
});

test('tilt: turning speed alone, a shake or a jolt, is nothing', () => {
  const shake = wrist(500, 600, () => 0, (s) => ({ gx: 400 * Math.sin(40 * s), gz: 300 * Math.cos(33 * s) }));
  assert.deepEqual(run([...hold(0, 500), ...shake, ...hold(1100, 500)], tilt()), []);
  const jolt = wrist(500, 30, () => 0, () => ({ ay: 3, az: 1 }));                        // 3 g sideways for 30 ms
  assert.deepEqual(run([...hold(0, 500), ...jolt, ...hold(530, 500)], tilt()), []);
});

test('tilt: nothing with the arm hanging, and raising it to level sends nothing', () => {
  const detector = tilt();
  assert.deepEqual(run([...hold(0, 500, 0, HANGING), ...hold(500, 500, 45, HANGING)], detector), []);
  assert.equal(detector.state.clutch, false);
  assert.deepEqual(run(hold(1000, 800, 45), detector), []);                              // comes up already turned: that is the centre
  assert.deepEqual(run(tip(1800, 45, 90).slice(50), detector), RIGHT);
});

test('tilt: works when readings arrive in packets that share one time', () => {
  const packets = tip(0, 0, 45).map((s) => ({ ...s, t: Math.floor(s.t / 50) * 50 }));
  assert.deepEqual(run(packets, tilt()), RIGHT);
});

test('tilt: works on a band that sits crooked, and with two calibration poses only', () => {
  const cal = computeCalibration(turned(hold(0, 2000)), turned(wrist(0, 2000, swing(40))));
  assert.equal(cal.swipeVec, null);
  assert.deepEqual(run(turned(tip(0, 0, 45)), tilt(cal)), RIGHT);
  assert.deepEqual(run(turned(tip(0, 0, -45)), tilt(cal)), LEFT);
});

test('tilt: a band whose gravity turns the other way is found in calibration', () => {
  const cal = computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40), undefined, -1));
  assert.equal(cal.rollSign, -1);
  const mirrored = tip(0, 0, 45).map((s) => ({ ...s, ay: -s.ay }));
  assert.deepEqual(run(mirrored, tilt(cal)), RIGHT);
});

test('tilt: taps still work', () => {
  const detector = tilt();
  run(hold(0, 300), detector);
  detector.tap('tap', 300);
  assert.deepEqual(detector.tap('double-tap', 450), [{ type: 'select' }]);
  assert.deepEqual(detector.tap('tap', 1200), []);
  assert.deepEqual(run(hold(300, 1300), detector), [{ type: 'toggle' }]);
});

test('tilt: the centre is the average of where the wrist settles, and follows a wrist resting near it', () => {
  const detector = tilt();
  const wobble = wrist(0, 400, (s) => 10 + 4 * Math.sin(40 * s));                        // settling at 10, not quite still
  run(wobble, detector);
  assert.ok(Math.abs(detector.state.roll) < 4, 'centred on 10, not on the first reading');
  run([...turn(400, 10, 18, 10), ...hold(1200, 1500, 18)], detector);                    // eases over to 18 and rests
  assert.ok(Math.abs(detector.state.roll) < 2, 'the centre followed: ' + detector.state.roll);
  assert.deepEqual(run(tip(2700, 18, 53).slice(50), detector), RIGHT);
  assert.deepEqual(run(tip(4500, 18, -17).slice(50), detector), LEFT);
});

test('tilt: the wrist turning while the arm moves around is not a step', () => {
  const detector = tilt();
  const swinging = wrist(500, 250, (s) => 180 * s, () => ({ gz: 150 }));                 // turns 45 degrees while the arm sweeps
  assert.deepEqual(run([...hold(0, 500), ...swinging, ...hold(750, 100, 45)], detector), []);
  assert.equal(detector.state.calm, false);
  assert.deepEqual(run(hold(850, 600, 45), detector), []);                               // settles: this is the centre now
  assert.equal(detector.state.calm, true);
  assert.deepEqual(run(tip(1450, 45, 90).slice(50), detector), RIGHT);
});

test('tilt: raising or lowering the forearm forgets the centre instead of stepping', () => {
  const detector = tilt();
  const lifted = (deg, roll) => ({ ax: Math.sin(deg * RAD), ay: Math.cos(deg * RAD) * Math.sin(roll * RAD), az: Math.cos(deg * RAD) * Math.cos(roll * RAD) });
  const rise = wrist(500, 800, () => 0, (s) => lifted(37.5 * s, 50 * s));                // up 30 degrees, wrist turning 40 on the way
  assert.deepEqual(run([...hold(0, 500), ...rise, ...wrist(1300, 800, () => 0, () => lifted(30, 40))], detector), []);
});

// ---- Tilt and the arm: a forearm turns outward more easily than inward ----

const onArm = (arm, more = {}) => createDetector(CAL, { ...CONFIG, gestures: 'tilt', wearingArm: arm, ...more });

test('tilt: on the left arm, left (outward) asks 30 degrees and right (inward) only 24', () => {
  assert.deepEqual(run(tip(0, 0, 27), onArm('left')), RIGHT);
  assert.deepEqual(run(tip(0, 0, -27), onArm('left')), []);
  assert.deepEqual(run(tip(0, 0, -35), onArm('left')), LEFT);
});

test('tilt: on the right arm it is the other way round', () => {
  assert.deepEqual(run(tip(0, 0, -27), onArm('right')), LEFT);
  assert.deepEqual(run(tip(0, 0, 27), onArm('right')), []);
  assert.deepEqual(run(tip(0, 0, 35), onArm('right')), RIGHT);
});

const eased = (arm) => onArm(arm, { tiltRangeShare: 0.45 });

test('tilt: by default the two distances are used as they are, wherever the wrist rests', () => {
  const detector = onArm('left');
  run(hold(0, 500, 70), detector);
  assert.equal(detector.state.limitRight, 24);
  assert.equal(detector.state.limitLeft, 30);
});

test('tilt, eased: resting turned inward leaves little room that way, so less is asked', () => {
  const detector = eased('left');                                       // left arm: inward is clockwise, to the right
  run(hold(0, 500, 35), detector);                                      // resting 35 degrees inward of thumb up
  assert.ok(Math.abs(detector.state.limitRight - 0.45 * 40) < 0.5, 'right asks ' + detector.state.limitRight);
  assert.equal(detector.state.limitLeft, 30);
  assert.deepEqual(run(tip(0, 35, 57), eased('left')), RIGHT);
  assert.deepEqual(run(tip(0, 35, 57, 800), eased('left')), RIGHT);     // held there: no second step, no step coming back
  const palmDown = eased('left');
  run(hold(0, 500, 70), palmDown);                                      // almost at the end of the range
  assert.equal(palmDown.state.limitRight, 15);                          // never less than tiltMinDegrees
});

test('tilt, eased: resting turned outward does the same on the outward side', () => {
  const detector = eased('right');                                      // right arm: outward is clockwise
  run(hold(0, 500, 60), detector);
  assert.equal(detector.state.limitRight, 15);
  assert.equal(detector.state.limitLeft, 24);
});

test('tilt: a tip that leaks onto the other axes, as a real wrist does, still counts', () => {
  const leaky = (list) => list.map((s) => ({ ...s, gy: 0.3 * s.gx, gz: -0.25 * s.gx }));
  assert.deepEqual(run(leaky(tip(0, 0, 45)), onArm('left')), RIGHT);
  const fast = [...hold(0, 500), ...turn(500, 0, 45, 400), ...hold(610, 300, 45), ...turn(910, 45, 0, 400), ...hold(1020, 600)];
  assert.deepEqual(run(leaky(fast), onArm('left')), RIGHT);
});

test('tilt: one stray reading of arm movement does not forget the centre', () => {
  const detector = onArm('left');
  const list = tip(0, 0, 45).map((s) => (s.t === 400 || s.t === 600 ? { ...s, gz: 300 } : s));
  assert.deepEqual(run(list, detector), RIGHT);
});

test('tilt: the page can see why nothing can fire', () => {
  const detector = onArm('left');
  run(hold(0, 300, 0, HANGING), detector);
  assert.equal(detector.state.why, 'arm not level');
  run([...hold(300, 400), ...wrist(700, 200, () => 0, () => ({ gz: 200 }))], detector);
  assert.equal(detector.state.why, 'arm turning');
  run(hold(900, 400), detector);
  assert.equal(detector.state.why, null);
});

// ---- Turn: every quick turn of the wrist is a step in its direction (the default) ----

const TURN = { ...CONFIG, gestures: 'turn', wearingArm: 'right' };      // right arm: 45 degrees right, 40 left
const turning = (config = TURN) => createDetector(CAL, config);
/** Hold, turn from one angle to another at `speed` deg/s, hold. */
const flip = (t0, from, to, speed = 400, rest = 500) => {
  const list = [...hold(t0, 300, from), ...turn(t0 + 300, from, to, speed)];
  return [...list, ...hold(list[list.length - 1].t + STEP, rest, to)];
};
const endOf = (list) => list[list.length - 1].t + STEP;

test('turn is the default', () => {
  assert.equal(DEFAULT_GESTURES, 'turn');
});

test('turn: a quick turn right is a step right, a quick turn left a step left', () => {
  const detector = turning();
  assert.deepEqual(run(flip(0, 0, 90), detector), RIGHT);
  assert.equal(detector.state.movement.result, 'Right');
  assert.deepEqual(run(flip(0, 0, -90), turning()), LEFT);
});

test('turn: with the free return off, turning over and back, staying at each end, is right, left, right, left', () => {
  const detector = turning({ ...TURN, turnRestDegrees: 0 });
  let t = 0; const out = [];
  for (const [from, to] of [[-60, 85], [85, -100], [-100, 60], [60, -100]]) {
    const list = flip(t, from, to, 500, 1400); t = endOf(list); out.push(...run(list, detector));
  }
  assert.deepEqual(out, [...RIGHT, ...LEFT, ...RIGHT, ...LEFT]);
});

test('turn: snapping straight back to rest after a step is not the opposite step', () => {
  const detector = turning();
  const there = flip(0, 0, 90, 500, 300), back = flip(endOf(there), 90, 0, 500, 300);
  assert.deepEqual(run(there, detector), RIGHT);
  assert.deepEqual(run(back, detector), []);
  assert.match(detector.state.missed, /going back to rest/);
  // Only the return is free: the next quick turn that way is a step, with a free return of its own.
  const left = flip(endOf(back), 0, -90, 500, 300), leftBack = flip(endOf(left), -90, 0, 500, 300);
  assert.deepEqual(run(left, detector), LEFT);
  assert.deepEqual(run(leftBack, detector), []);
  assert.deepEqual(run(flip(endOf(leftBack), 0, 90, 500, 300), detector), RIGHT);
});

test('turn: rest is where the wrist lies still for a few seconds, so after that a quick turn from there is a step', () => {
  const detector = turning();
  const there = flip(0, 0, 90, 500, CONFIG.turnRestMs + 500);            // right, and stay there: that is rest now
  assert.deepEqual(run(there, detector), RIGHT);
  assert.ok(Math.abs(detector.state.turned) < 5, 'turned ' + detector.state.turned.toFixed(0));
  assert.deepEqual(run(flip(endOf(there), 90, 0, 500, 300), detector), LEFT);
});

test('turn: holding the wrist turned for two seconds and then snapping back is still the return', () => {
  const detector = turning();
  const there = flip(0, 0, 90, 500, 2000);
  assert.deepEqual(run(there, detector), RIGHT);
  assert.deepEqual(run(flip(endOf(there), 90, 0, 500, 300), detector), []);
  assert.match(detector.state.missed, /going back to rest/);
});

test('turn: after a slow return, a quick turn the other way is a step', () => {
  const detector = turning();
  const there = flip(0, 0, 90, 500, 300), back = flip(endOf(there), 90, 0, 120, 300);
  assert.deepEqual(run(there, detector), RIGHT);
  assert.deepEqual(run(back, detector), []);
  assert.deepEqual(run(flip(endOf(back), 0, -90, 500, 300), detector), LEFT);
});

test('turn: the same way twice with quick returns is two steps', () => {
  const detector = turning();
  let t = 0; const out = [];
  for (const [from, to] of [[0, 90], [90, 0], [0, 90], [90, 0]]) {
    const list = flip(t, from, to, 500, 300); t = endOf(list); out.push(...run(list, detector));
  }
  assert.deepEqual(out, [...RIGHT, ...RIGHT]);
});

test('turn: turnRestDegrees 0 counts the quick turn back, as before', () => {
  const detector = turning({ ...TURN, turnRestDegrees: 0 });
  const there = flip(0, 0, 90, 500, 600);
  assert.deepEqual([...run(there, detector), ...run(flip(endOf(there), 90, 0, 500, 600), detector)], [...RIGHT, ...LEFT]);
});

test('turn: a turn of more than half a circle keeps its direction', () => {
  assert.deepEqual(run(flip(0, 85, -115, 900), turning()), LEFT);        // 200 degrees to the left
  assert.deepEqual(run(flip(0, -100, 100, 900), turning()), RIGHT);
});

test('turn: a slow turn is free, so the same way twice is: quick, slow back, quick', () => {
  const detector = turning();
  const first = flip(0, 0, 90), back = flip(endOf(first), 90, 0, 120), second = flip(endOf(back), 0, 90);
  assert.deepEqual(run(first, detector), RIGHT);
  assert.deepEqual(run(back, detector), []);
  assert.match(detector.state.missed, /going back to rest/);
  assert.deepEqual(run(second, detector), RIGHT);
});

test('turn: a slow turn from rest is not a step, and says so', () => {
  const detector = turning();
  assert.deepEqual(run(flip(0, 0, 90, 120), detector), []);
  assert.match(detector.state.missed, /too slow: peak 1\d\d of 150/);
});

test('turn: right, then straight over past rest to the left, is right then left', () => {
  const detector = turning();
  const right = flip(0, 0, 90, 500, 800), over = flip(endOf(right), 90, -90, 500, 800);
  assert.deepEqual(run(right, detector), RIGHT);
  assert.deepEqual(run(over, detector), LEFT);
  // And back to rest from there is free.
  assert.deepEqual(run(flip(endOf(over), -90, 0, 500, 800), detector), []);
});

test('turn: a turn out that was too slow to count still makes the quick turn back free', () => {
  const detector = turning();
  const out = flip(0, 0, -90, 120, 800);
  assert.deepEqual(run(out, detector), []);
  assert.deepEqual(run(flip(endOf(out), -90, 0, 500, 800), detector), []);       // not a step right
  assert.match(detector.state.missed, /going back to rest/);
});

test('turn: a small wobble is nothing, and a turn that falls short says how far it got', () => {
  const detector = turning();
  assert.deepEqual(run(flip(0, 0, 15), detector), []);
  assert.equal(detector.state.missed, null);                            // too small to mention
  assert.deepEqual(run(flip(1000, 15, 45), detector), []);
  assert.match(detector.state.missed, /too small: 3\d of 45 degrees/);
});

test('turn: one long turn is one step, and the bounce at its end is not another', () => {
  const list = [...hold(0, 300), ...turn(300, 0, 180, 600), ...turn(600, 180, 165, 150), ...hold(700, 500, 165)];
  assert.deepEqual(run(list, turning()), RIGHT);
});

test('turn: the arm moving around is not a step, even with the wrist turning in it', () => {
  const detector = turning();
  const swing = wrist(300, 300, (s) => 300 * s, () => ({ gz: 350 }));    // the wrist turns 90 while the arm sweeps 105
  assert.deepEqual(run([...hold(0, 300), ...swing, ...hold(600, 500, 90)], detector), []);
  assert.match(detector.state.missed, /arm was moving/);
  const leaky = flip(1200, 90, -60, 500).map((s) => ({ ...s, gy: 0.3 * s.gx }));        // a real wrist leaks a little
  assert.deepEqual(run(leaky, detector), LEFT);                         // over past rest to the left: a step
});

test('turn: nothing with the arm hanging, and taps still work', () => {
  const detector = turning();
  const hanging = [...hold(0, 300, 0, HANGING), ...wrist(300, 300, () => 0, () => ({ ...HANGING, gx: 500 })), ...hold(600, 400, 0, HANGING)];
  assert.deepEqual(run(hanging, detector), []);
  const other = turning();
  run(hold(0, 300), other);
  other.tap('tap', 300);
  assert.deepEqual(other.tap('double-tap', 450), [{ type: 'select' }]);
});

test('turn: the two ways have their own distance, by the arm the band is on', () => {
  const left = { ...TURN, wearingArm: 'left' };                         // left arm: outward is left
  assert.deepEqual(run(flip(0, 0, 42), turning(left)), RIGHT);          // inward: 40
  assert.deepEqual(run(flip(0, 0, -42), turning(left)), []);            // outward: 45
  assert.deepEqual(run(flip(0, 0, -42), turning()), LEFT);              // right arm: the other way round
});

test('turn: works on a band that sits crooked', () => {
  const cal = computeCalibration(turned(hold(0, 2000)), turned(wrist(0, 2000, swing(40))));
  assert.deepEqual(run(turned(flip(0, 0, 90)), createDetector(cal, TURN)), RIGHT);
  assert.deepEqual(run(turned(flip(0, 0, -90)), createDetector(cal, TURN)), LEFT);
});

test('turn: the recording from the real band gives every turn, in its direction, and nothing for the arm', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/real-wrist-turns.json', import.meta.url), 'utf8'));
  // The recording turns over and back without waiting: with the free return off, every turn shows.
  const detector = createDetector(real.calibration, { ...CONFIG, gestures: 'turn', wearingArm: 'left', turnRestDegrees: 0 });
  const steps = [];
  for (const [t, ax, ay, az, gx, gy, gz] of real.samples) {
    for (const m of detector.update({ t, ax, ay, az, gx, gy, gz })) steps.push([Math.round(t / 100) / 10, m.direction]);
  }
  // Eight wrist turns in the first 12 seconds. The arm raised twice (14 s, 17 s) and swung four times (50 to 68 s): nothing.
  assert.deepEqual(steps.map(([, d]) => d), [1, -1, 1, -1, 1, -1, 1, -1]);
  assert.ok(steps.every(([t]) => t < 12), JSON.stringify(steps));
});

// ---- Turn: the pause that confirms a step (turnPauseMs above 0; off by default) ----

const PAUSED = { ...TURN, turnPauseMs: 150 };

test('turn: the step is sent after the wrist has paused, not in the middle of the turn', () => {
  const detector = turning(PAUSED);
  const list = flip(0, 0, 120, 400);                                     // turning from 300 to 600 ms
  const sentAt = list.find((s) => detector.update(s).length > 0).t;
  assert.ok(sentAt >= 600 + PAUSED.turnPauseMs - STEP && sentAt <= 600 + PAUSED.turnPauseMs + 3 * STEP, 'sent at ' + sentAt);
  const atOnce = turning({ ...TURN, turnPauseMs: 0 });
  const early = flip(0, 0, 120, 400).find((s) => atOnce.update(s).length > 0).t;
  assert.ok(early < 450, 'with no pause it is sent mid-turn, at ' + early);
});

test('turn: shaking the wrist back and forth sends at most its last swing, with the pause', () => {
  const shake = wrist(300, 900, (s) => 60 * Math.sin(2 * Math.PI * 3 * s));             // 60 degrees each way, three times a second
  const list = [...hold(0, 300), ...shake, ...hold(1200, 600, -57)];                    // it stops where the last swing ended
  const detector = turning(PAUSED);
  const withPause = run(list, detector);
  const noPause = run(list, turning({ ...TURN, turnPauseMs: 0 }));
  assert.ok(noPause.length >= 2, 'without the pause the shake sends ' + noPause.length + ' steps');
  assert.ok(withPause.length <= 1, 'with the pause: ' + withPause.length);          // only the swing it came to rest after
});

test('turn: a wrist turn that runs on into arm movement is nothing, with the pause', () => {
  const detector = turning(PAUSED);
  const list = [...hold(0, 300), ...turn(300, 0, 60, 400), ...wrist(450, 500, () => 60, () => ({ gz: 300 })), ...hold(950, 500, 60)];
  assert.deepEqual(run(list, detector), []);
  assert.match(detector.state.missed, /arm was moving/);
});

test('turn: a wrist that never comes to rest sends nothing', () => {
  const detector = turning(PAUSED);
  const list = [...hold(0, 300), ...turn(300, 0, 60, 400), ...wrist(450, 1500, (s) => 60 + 200 * s)];   // keeps turning at 200 deg/s
  assert.deepEqual(run(list, detector), []);
  assert.match(detector.state.missed, /no pause after the turn/);
});

// ---- Turn: the wrist's axis is learned in use ----

/** The same motion as seen by a band that has slipped round the wrist: the wrist's axis moved by `deg` degrees. */
function slipped(list, deg) {
  const c = Math.cos(deg * RAD), k = Math.sin(deg * RAD);              // rotate every reading about y: x -> towards z
  const rot = (v) => [v[0] * c + v[2] * k, v[1], -v[0] * k + v[2] * c];
  return list.map((s) => { const a = rot([s.ax, s.ay, s.az]), g = rot([s.gx, s.gy, s.gz]); return { t: s.t, ax: a[0], ay: a[1], az: a[2], gx: g[0], gy: g[1], gz: g[2] }; });
}

test('turn: a band that slipped since calibration is refused at first, then learned from the turns themselves', () => {
  // With the arm share at a strict half, so that 28 degrees off is enough to be refused.
  const fixed = turning({ ...TURN, turnAxisLearn: 0, turnRestDegrees: 0, turnArmShare: 0.5 });
  const learning = turning({ ...TURN, turnRestDegrees: 0, turnArmShare: 0.5 });   // every turn shows: no free return
  let t = 0; const withLearning = [], without = [];
  for (let i = 0; i < 6; i++) {
    const list = slipped(flip(t, i % 2 ? 100 : 0, i % 2 ? 0 : 100, 500, 600), 28);
    t = endOf(list); withLearning.push(...run(list, learning)); without.push(...run(list, fixed));
  }
  assert.deepEqual(without, []);                                        // 28 degrees off: every turn looks like the arm moving
  assert.match(fixed.state.missed, /arm was moving/);
  assert.deepEqual(withLearning.slice(-4), [...RIGHT, ...LEFT, ...RIGHT, ...LEFT]);
  assert.ok(learning.state.axisOff > 20, 'the axis moved ' + learning.state.axisOff.toFixed(0) + ' degrees');
});

test('turn: arm movement does not teach the axis, and it never drifts far from its anchor', () => {
  const detector = turning({ ...TURN, turnAxisAnchorTurns: 0 });         // the anchor stays at calibration
  let t = 0;
  for (let i = 0; i < 8; i++) {                                         // the arm swinging: turning about z, far from the wrist's axis
    const list = [...hold(t, 300), ...wrist(t + 300, 300, () => 0, () => ({ gz: i % 2 ? -400 : 400 })), ...hold(t + 600, 500)];
    t = endOf(list); assert.deepEqual(run(list, detector), []);
  }
  assert.equal(detector.state.axisOff, 0);
  for (let i = 0; i < 12; i++) {                                        // a band slipping further each time: followed, but only so far
    const list = slipped(flip(t, i % 2 ? 100 : 0, i % 2 ? 0 : 100, 500, 400), 5 * (i + 1));
    t = endOf(list); run(list, detector);
  }
  assert.ok(detector.state.axisOff <= CONFIG.turnAxisMaxDrift + 0.5, 'drifted ' + detector.state.axisOff.toFixed(0));
});

test('turn: a band that keeps slipping is followed past the first limit, by re-anchoring, but not for ever', () => {
  // The pretend slip also tips gravity, which the clutch would take for the arm leaving level: clutch wide open.
  const detector = turning({ ...TURN, turnRestDegrees: 0, clutchDegrees: 180 });
  let t = 0; const out = [];
  const turns = (deg, count) => {
    for (let i = 0; i < count; i++) {
      const list = slipped(flip(t, i % 2 ? 100 : 0, i % 2 ? 0 : 100, 500, 600), deg);
      t = endOf(list); out.push(...run(list, detector));
    }
  };
  turns(28, 10); turns(50, 10); turns(70, 10);
  assert.ok(detector.state.axisOff > 60 && detector.state.axisOff < 75, 'followed to ' + detector.state.axisOff.toFixed(0));
  assert.deepEqual(out.slice(-4), [...RIGHT, ...LEFT, ...RIGHT, ...LEFT]);
  assert.ok(angleBetween(detector.state.anchor, CAL.twistVec) <= CONFIG.turnAxisAnchorMax);
  turns(110, 12);                                                       // further than any anchor may go
  assert.ok(angleBetween(detector.state.anchor, CAL.twistVec) <= CONFIG.turnAxisAnchorMax);
});

test('the gyro resting offset is followed while the band is still, and only then', () => {
  const detector = createDetector(CAL, TURN);
  const drifted = (list) => list.map((s) => ({ ...s, gx: s.gx + 4, gz: s.gz - 3 }));
  run(drifted(hold(0, 1500)), detector);
  assert.ok(Math.abs(detector.state.biasOff - 5) < 0.2, 'offset moved ' + detector.state.biasOff.toFixed(1));
  // With the offset followed, the drift is not taken for the wrist turning: a quick turn still counts once.
  assert.deepEqual(run(drifted(flip(1500, 0, 90)), detector), RIGHT);
  const moving = createDetector(CAL, TURN);                              // a slow steady turn is not a resting band
  run(turn(0, 0, 30, 8), moving);
  assert.equal(moving.state.biasOff, 0);
  const wild = createDetector(CAL, TURN);                                // an offset too big to be drift is not believed
  run(hold(0, 1500).map((s) => ({ ...s, gx: 25 })), wild);
  assert.equal(wild.state.biasOff, 0);
});

test('turn: a learned axis handed back in the calibration is used from the first turn', () => {
  const learning = turning();
  let t = 0;
  for (let i = 0; i < 4; i++) { const list = slipped(flip(t, i % 2 ? 100 : 0, i % 2 ? 0 : 100, 500, 600), 28); t = endOf(list); run(list, learning); }
  const next = createDetector({ ...CAL, wristAxis: learning.state.axis }, { ...TURN, turnAxisLearn: 0 });
  assert.deepEqual(run(slipped(flip(0, 0, 100, 500, 600), 28), next), RIGHT);
});

test('turn: the recording of a band that had shifted 22 degrees gives rights and lefts alike once the axis is learned', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/real-shifted-band.json', import.meta.url), 'utf8'));
  const steps = (learn) => {
    const detector = createDetector(real.calibration, { ...CONFIG, gestures: 'turn', wearingArm: 'left', turnAxisLearn: learn, turnRestDegrees: 0 });
    const out = [];
    for (const [t, ax, ay, az, gx, gy, gz] of real.samples) for (const m of detector.update({ t, ax, ay, az, gx, gy, gz })) out.push(m.direction);
    return out;
  };
  const learned = steps(CONFIG.turnAxisLearn);
  assert.ok(steps(0).length <= learned.length, 'learning does not lose turns that calibration alone finds');
  const rights = learned.filter((d) => d > 0).length, lefts = learned.length - rights;
  assert.ok(rights >= 6 && lefts >= 6, JSON.stringify(learned));
  assert.ok(Math.abs(rights - lefts) <= 1, 'balanced: ' + rights + ' right, ' + lefts + ' left');
});
