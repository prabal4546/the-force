// Tests for gestures.js with synthetic samples: no band needed.  Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, angleBetween, computeCalibration, clutchAngle, createDetector } from '../gestures.js';

const STEP = 10;                                   // ms between samples: 100 a second
const LEVEL = { ax: 0, ay: 0, az: 1 };             // arm level: gravity on z
const HANGING = { ax: 1, ay: 0, az: 0 };           // arm at the side: gravity along the forearm (x)

/** `ms` of samples starting at `t0`; `fn(seconds)` gives the fields that differ from rest. */
function samples(t0, ms, fn = () => ({}), pose = LEVEL) {
  const out = [];
  for (let t = 0; t < ms; t += STEP) out.push({ t: t0 + t, gx: 0, gy: 0, gz: 0, ...pose, ...fn(t / 1000) });
  return out;
}

// Calibration recordings: twist about x (clockwise first), flick about z (right first).
const wave = (axis, peak) => (s) => ({ [axis]: peak * Math.sin(2 * Math.PI * 1.5 * s + 0.3) });
const CAL = computeCalibration(samples(0, 2000), samples(0, 2000, wave('gx', 200)), samples(0, 2000, wave('gz', 300)));

/** Run samples through a fresh detector (or the one given); returns every message. */
function run(list, detector = createDetector(CAL)) {
  return list.flatMap((s) => detector.update(s));
}

test('calibration finds gravity, the twist axis and the flick axis', () => {
  assert.equal(CAL.twistAxis, 'gx');
  assert.equal(CAL.flickAxis, 'gz');
  assert.ok(angleBetween(CAL.gravity, [0, 0, 1]) < 1);
  assert.equal(CAL.twistSign, 1);
  assert.equal(CAL.flickSign, 1);
});

test('calibration takes the strongest remaining axis for flick, even when twist leaks into it', () => {
  const flick = samples(0, 2000, (s) => ({ ...wave('gx', 400)(s), ...wave('gy', 250)(s), ...wave('gz', 60)(s) }));
  const cal = computeCalibration(samples(0, 2000), samples(0, 2000, wave('gx', 200)), flick);
  assert.equal(cal.flickAxis, 'gy');
});

test('calibration refuses a pose that did not move', () => {
  assert.throws(() => computeCalibration(samples(0, 2000), samples(0, 2000), samples(0, 2000, wave('gz', 300))), /twist pose/);
});

test('a first swing the other way flips the sign', () => {
  const cal = computeCalibration(samples(0, 2000), samples(0, 2000, wave('gx', -200)), samples(0, 2000, wave('gz', 300)));
  assert.equal(cal.twistSign, -1);
});

test('twist: 90 degrees at 90 deg/s gives six adjusts of +0.05', () => {
  const out = run([...samples(0, 300), ...samples(300, 1000, () => ({ gx: 90 })), ...samples(1300, 400)]);
  assert.deepEqual(out, Array(6).fill({ type: 'adjust', delta: 0.05 }));
});

test('twist the other way gives negative adjusts', () => {
  const out = run([...samples(0, 300), ...samples(300, 550, () => ({ gx: -120 }))]);
  assert.equal(out.length, 4);
  assert.ok(out.every((m) => m.type === 'adjust' && m.delta === -0.05));
});

test('turning slower than 30 deg/s is ignored', () => {
  assert.deepEqual(run(samples(0, 3000, () => ({ gx: 25 }))), []);
});

test('turning the wrist does not open the clutch (gravity rotates about the forearm)', () => {
  const rolled = { ax: 0, ay: Math.sin(1.2), az: Math.cos(1.2) };      // wrist rolled about 69 degrees
  assert.ok(clutchAngle([rolled.ax, rolled.ay, rolled.az], CAL) < 1);
  const out = run([...samples(0, 300, undefined, rolled), ...samples(300, 500, () => ({ gx: 90 }), rolled)]);
  assert.equal(out.length, 3);
});

test('nothing fires while the arm hangs at the side', () => {
  const list = [
    ...samples(0, 500, undefined, HANGING),
    ...samples(500, 1000, () => ({ gx: 200 }), HANGING),                // would be a twist
    ...samples(1500, 100, () => ({ gz: 400 }), HANGING),                // would be a flick
    ...samples(1600, 500, undefined, HANGING),
  ];
  const detector = createDetector(CAL);
  assert.deepEqual(run(list, detector), []);
  assert.equal(detector.state.clutch, false);
});

test('flick: a 100 ms spike gives one step, and the swing back is inside the cooldown', () => {
  const out = run([
    ...samples(0, 300),
    ...samples(300, 100, () => ({ gz: 400 })),
    ...samples(400, 50),
    ...samples(450, 100, () => ({ gz: -400 })),                         // the hand coming back
    ...samples(550, 600),
  ]);
  assert.deepEqual(out, [{ type: 'step', direction: 1 }]);
});

test('flick the other way gives direction -1', () => {
  const out = run([...samples(0, 300), ...samples(300, 80, () => ({ gz: -500 })), ...samples(380, 300)]);
  assert.deepEqual(out, [{ type: 'step', direction: -1 }]);
});

test('a sweep longer than 200 ms is not a flick', () => {
  assert.deepEqual(run([...samples(0, 300), ...samples(300, 300, () => ({ gz: 300 })), ...samples(600, 300)]), []);
});

test('a spike with twist in it is not a flick', () => {
  const out = run([...samples(0, 300), ...samples(300, 100, () => ({ gz: 400, gx: 200 })), ...samples(400, 300)]);
  assert.ok(out.every((m) => m.type !== 'step'));
});

test('a flick that leaks a little onto the twist axis is still only a step', () => {
  const out = run([...samples(0, 300), ...samples(300, 100, () => ({ gz: 400, gx: 90 })), ...samples(400, 300)]);
  assert.deepEqual(out, [{ type: 'step', direction: 1 }]);
});

test('a tap alone becomes toggle after the delay', () => {
  const detector = createDetector(CAL);
  run(samples(0, 300), detector);
  assert.deepEqual(detector.tap('tap', 300), []);
  assert.deepEqual(run(samples(300, 290), detector), []);
  assert.deepEqual(run(samples(590, 100), detector), [{ type: 'toggle' }]);
});

test('a tap followed by a double-tap is one select and no toggle', () => {
  const detector = createDetector(CAL);
  run(samples(0, 300), detector);
  detector.tap('tap', 300);
  assert.deepEqual(detector.tap('double-tap', 450), [{ type: 'select' }]);
  assert.deepEqual(run(samples(300, 1000), detector), []);
});

test('with no tap before double-taps, toggle fires at once', () => {
  const detector = createDetector(CAL, { ...CONFIG, tapBeforeDoubleTap: false });
  run(samples(0, 300), detector);
  assert.deepEqual(detector.tap('tap', 300), [{ type: 'toggle' }]);
});

test('one gesture at a time: a tap during the cooldown after a flick is dropped', () => {
  const detector = createDetector(CAL);
  const out = run([...samples(0, 300), ...samples(300, 100, () => ({ gz: 400 })), ...samples(400, 20)], detector);
  assert.equal(out.length, 1);
  assert.deepEqual(detector.tap('tap', 500), []);
  assert.deepEqual(run(samples(420, 1500), detector), []);
});

test('a twist ends with a cooldown: a flick right after it is dropped, a later one counts', () => {
  const detector = createDetector(CAL);
  const twist = run([...samples(0, 300), ...samples(300, 400, () => ({ gx: 90 })), ...samples(700, 300)], detector);
  assert.equal(twist.length, 2);
  assert.deepEqual(run([...samples(1000, 100, () => ({ gz: 400 })), ...samples(1100, 400)], detector), []);
  assert.deepEqual(run([...samples(1500, 100, () => ({ gz: 400 })), ...samples(1600, 100)], detector), [{ type: 'step', direction: 1 }]);
});
