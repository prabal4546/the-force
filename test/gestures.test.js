// Tests for gestures.js with synthetic samples: no band needed.  Run: npm test
//
// The pretend wrist: the forearm lies along x, level gravity is on z. Rolling the wrist by
// `roll` degrees turns gravity about x and shows on gx; a flick shows on gz only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG, angleBetween, checkPose, computeCalibration, clutchAngle, createDetector, flickThreshold,
} from '../gestures.js';

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
const flick = (t0, ms, dps, twistDps = 0) => wrist(t0, ms, () => 0, () => ({ gz: dps, gx: twistDps }));

const swing = (peak) => (s) => peak * Math.sin(2 * Math.PI * 1.5 * s + 0.3);          // degrees, clockwise first
const flickPose = (peak) => wrist(0, 2000, () => 0, (s) => ({ gz: peak * Math.sin(2 * Math.PI * 1.5 * s + 0.3) }));
const CAL = computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40)), flickPose(500));

/** Run samples through a fresh detector (or the one given); returns every message. */
function run(list, detector = createDetector(CAL)) {
  return list.flatMap((s) => detector.update(s));
}
const adjusts = (n, delta) => Array(n).fill({ type: 'adjust', delta });

test('calibration finds gravity, the axes, the gyro bias and the flick strength', () => {
  assert.equal(CAL.twistAxis, 'gx');
  assert.equal(CAL.flickAxis, 'gz');
  assert.ok(angleBetween(CAL.gravity, [0, 0, 1]) < 1);
  assert.equal(CAL.twistSign, 1);
  assert.equal(CAL.flickSign, 1);
  assert.ok(Math.abs(CAL.bias.gx) < 1);
  assert.ok(CAL.flickPeak > 450 && CAL.flickPeak <= 500);
});

test('calibration takes the strongest remaining axis for flick, even when twist leaks into it', () => {
  const pose = wrist(0, 2000, swing(40), (s) => ({ gy: 250 * Math.sin(9 * s), gz: 60 * Math.sin(9 * s) }));
  assert.equal(computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40)), pose).flickAxis, 'gy');
});

test('calibration refuses a pose that did not move', () => {
  assert.throws(() => computeCalibration(hold(0, 2000), hold(0, 2000), flickPose(500)), /twist pose/);
});

test('a gentle flick in calibration lowers the flick threshold, but not below the floor', () => {
  assert.equal(flickThreshold({ ...CAL, flickPeak: 700 }), 250);
  assert.equal(flickThreshold({ ...CAL, flickPeak: 400 }), 200);
  assert.equal(flickThreshold({ ...CAL, flickPeak: 200 }), 150);
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
  const cal = computeCalibration(hold(0, 2000), wrist(0, 2000, swing(40), undefined, -1), flickPose(500));
  assert.notEqual(cal.rollSign, CAL.rollSign);
  const out = run([...hold(0, 500), ...turn(500, 0, 65, 130, -1), ...turn(1000, 65, 0, 130, -1), ...hold(1500, 800)], createDetector(cal));
  assert.deepEqual(out, adjusts(4, 0.05));
});

test('pausing at the far end still gives a free return', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, 50, 100), ...hold(1000, 700, 50), ...turn(1700, 50, 0, 100), ...hold(2200, 800)]);
  assert.deepEqual(out, adjusts(3, 0.05));
});

test('turning further after a pause only sends the extra steps', () => {
  const out = run([...hold(0, 500), ...turn(500, 0, 35, 100), ...hold(850, 600, 35), ...turn(1450, 35, 65, 100), ...hold(1750, 300, 65)]);
  assert.deepEqual(out, adjusts(4, 0.05));
});

test('a twist that never comes back does not block flicks and taps', () => {
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
  assert.equal(checkPose('flick', flickPose(500), { level, twist }), null);
  assert.match(checkPose('flick', twist, { level, twist }), /twist again/);
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
    ...wrist(1500, 100, () => 0, () => ({ ...HANGING, gz: 400 })),      // would be a flick
    ...hold(1600, 500, 0, HANGING),
  ];
  const detector = createDetector(CAL);
  assert.deepEqual(run(list, detector), []);
  assert.equal(detector.state.clutch, false);
});

test('flick: a 100 ms spike gives one step, and the swing back is inside the cooldown', () => {
  const out = run([...hold(0, 300), ...flick(300, 100, 400), ...hold(400, 50), ...flick(450, 100, -400), ...hold(550, 600)]);
  assert.deepEqual(out, [{ type: 'step', direction: 1 }]);
});

test('flick the other way gives direction -1', () => {
  assert.deepEqual(run([...hold(0, 300), ...flick(300, 80, -500), ...hold(380, 300)]), [{ type: 'step', direction: -1 }]);
});

test('a sweep longer than 200 ms is not a flick, and says why', () => {
  const detector = createDetector(CAL);
  assert.deepEqual(run([...hold(0, 300), ...flick(300, 300, 300), ...hold(600, 300)], detector), []);
  assert.match(detector.state.missedFlick, /too long: 300 ms/);
});

test('a spike with as much twist as flick is not a flick', () => {
  const detector = createDetector(CAL);
  const out = run([...hold(0, 300), ...flick(300, 100, 400, 350), ...hold(400, 300)], detector);
  assert.ok(out.every((m) => m.type !== 'step'));
  assert.match(detector.state.missedFlick, /twist in it/);
});

test('a flick that leaks onto the twist axis is one step and no adjust', () => {
  assert.deepEqual(run([...hold(0, 300), ...flick(300, 100, 400, 200), ...hold(400, 600)]), [{ type: 'step', direction: 1 }]);
});

test('a gentle flicker gets a lower threshold from calibration', () => {
  const gentle = { ...CAL, flickPeak: 360 };                            // threshold 180
  assert.deepEqual(run([...hold(0, 300), ...flick(300, 100, 220), ...hold(400, 300)]), []);
  assert.deepEqual(run([...hold(0, 300), ...flick(300, 100, 220), ...hold(400, 300)], createDetector(gentle)), [{ type: 'step', direction: 1 }]);
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

test('one gesture at a time: a tap during the cooldown after a flick is dropped', () => {
  const detector = createDetector(CAL);
  assert.equal(run([...hold(0, 300), ...flick(300, 100, 400), ...hold(400, 20)], detector).length, 1);
  assert.deepEqual(detector.tap('tap', 500), []);
  assert.deepEqual(run(hold(420, 1500), detector), []);
});

test('a twist ends with a cooldown: a flick right after it is dropped, a later one counts', () => {
  const detector = createDetector(CAL);
  assert.equal(run([...hold(0, 500), ...turn(500, 0, 35, 100), ...turn(850, 35, 0, 100), ...hold(1200, 100)], detector).length, 2);
  assert.deepEqual(run([...flick(1300, 100, 400), ...hold(1400, 500)], detector), []);
  assert.deepEqual(run([...flick(1900, 100, 400), ...hold(2000, 100)], detector), [{ type: 'step', direction: 1 }]);
});
