// Band module for the universal remote: wrist gestures in, messages out.
// Transport-free: the hub glue calls onEvent() and handle(); nothing here knows which
// device is active. The page hands in a connected band with attach(band).

import { CONFIG, createDetector, computeCalibration } from './gestures.js';

export { CONFIG };

const STORAGE_KEY = 'vexo-band-calibration';
const listeners = new Set();     // outgoing messages
const noteListeners = new Set(); // short sentences for the person (problems, hints)

let band = null;
let calibration = loadCalibration();
let detector = calibration ? createDetector(calibration, CONFIG) : null;
let recording = null;            // samples of the calibration pose being recorded
let outbox = [];                 // messages waiting to leave the motion handler
let baseColour = null;           // the LED colour to return to after a flash (null = off)
let lastFlash = 0;
let flashing = false;
let lastTapTime = -Infinity;
const tapCheck = { doubleTaps: 0, withTapBefore: 0 };

// ---- The module interface -------------------------------------------------------------

/** Call `callback(message)` for each outgoing message. Returns a function that stops it. */
export function onEvent(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Accept an incoming message from the hub. Phase 1 only remembers the active colour. */
export function handle(message) {
  if (message && message.type === 'active' && typeof message.color === 'string') baseColour = message.color;
}

// ---- For the page ---------------------------------------------------------------------

/** Call `callback(text)` with sentences meant for the person. */
export function onNote(callback) {
  noteListeners.add(callback);
  return () => noteListeners.delete(callback);
}

/** Start working with a connected band: 100 samples a second, both sensors, plus events. */
export async function attach(connectedBand) {
  band = connectedBand;
  band.on('motion', onMotion);
  band.on('tap', (e) => onTap('tap', e));
  band.on('double-tap', (e) => onTap('double-tap', e));
  band.on('disconnect', () => { band = null; recording = null; });
  await band.configure({ motion: CONFIG.motionRate, sensors: 'both', events: true });
}

/** Record the motion of one calibration pose for CONFIG.poseMs. Resolves with the samples. */
export function recordPose() {
  recording = [];
  return new Promise((resolve) => setTimeout(() => {
    const samples = recording || [];
    recording = null;
    resolve(samples);
  }, CONFIG.poseMs));
}

/** Work out and save the calibration from the three recorded poses. Throws with a sentence to show. */
export function finishCalibration(level, twist, flick) {
  calibration = computeCalibration(level, twist, flick, CONFIG);
  detector = createDetector(calibration, CONFIG);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration)); } catch { /* no storage: keep it in memory */ }
  return calibration;
}

/** What the page shows: clutch, calibrated axes, and the tap-before-double-tap check. */
export function getState() {
  return {
    connected: band !== null,
    calibration,
    clutch: detector ? detector.state.clutch : false,
    angle: detector ? detector.state.angle : null,
    twisting: detector ? detector.state.twisting : false,
    tapCheck: { ...tapCheck },
  };
}

// ---- Inside ---------------------------------------------------------------------------

function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && saved.twistAxis && saved.flickAxis && Array.isArray(saved.gravity) ? saved : null;
  } catch { return null; }                     // no storage (tests) or a broken entry
}

// Runs 100 times a second: collect and detect only, everything slow happens later.
function onMotion(sample) {
  if (recording) { recording.push(sample); return; }
  if (detector) send(detector.update(sample));
}

function onTap(kind, event) {
  if (kind === 'tap') lastTapTime = event.t;
  else {
    tapCheck.doubleTaps += 1;
    if (event.t - lastTapTime <= CONFIG.tapCheckMs) tapCheck.withTapBefore += 1;
  }
  if (detector && !recording) send(detector.tap(kind, event.t));
}

function send(messages) {
  if (messages.length === 0) return;
  if (outbox.length === 0) setTimeout(flush, 0);
  outbox.push(...messages);
}

function flush() {
  const messages = outbox;
  outbox = [];
  for (const message of messages) {
    for (const listener of listeners) {
      try { listener(message); } catch (e) { note('A listener failed: ' + e.message); }
    }
  }
  flash();
}

function note(text) {
  for (const listener of noteListeners) listener(text);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Show our own colour again (or off). */
async function restoreLed() {
  if (!band) return;
  if (baseColour) await band.setLed(baseColour); else await band.ledOff();
}

/** A short white flash, then back to our colour. Never more often than CONFIG.flashGapMs. */
async function flash() {
  const now = Date.now();
  if (!band || flashing || now - lastFlash < CONFIG.flashGapMs) return;
  flashing = true;
  lastFlash = now;
  try {
    await band.setLed('#ffffff');
    await pause(CONFIG.flashMs);
    await restoreLed();
  } catch (e) {
    if (e.code !== 'denied' && e.code !== 'not-connected') note(e.message);   // denied: the microphone owns the light
  } finally {
    flashing = false;
  }
}
