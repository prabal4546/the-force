// Band module for the universal remote: wrist gestures in, messages out.
// Transport-free: the hub glue calls onEvent() and handle(); nothing here knows which
// device is active. The page hands in a connected band with attach(band).

import { CONFIG, createDetector, createRaiseDetector, computeCalibration } from './gestures.js';
import { deepgramLink } from './speech.js';

export { CONFIG };

const STORAGE_KEY = 'vexo-band-calibration';
const listeners = new Set();     // outgoing messages
const noteListeners = new Set(); // short sentences for the person (problems, hints)

let band = null;
let calibration = loadCalibration();
let detector = calibration ? createDetector(calibration, CONFIG) : null;
let raiser = calibration && calibration.raiseSign ? createRaiseDetector(calibration, CONFIG) : null;
let deepgramKey = '';            // handed in by the page; never stored here
let voice = null;                // the raise-to-talk session that is running, or null
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

/** Accept an incoming message from the hub. So far it only remembers the active colour. */
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
  band.on('audio', (a) => { if (voice && voice.link) voice.link.packet(a.opus); });
  band.on('disconnect', () => { band = null; recording = null; endVoice(); });
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

/** Work out and save the calibration from the four recorded poses. Throws with a sentence to show. */
export function finishCalibration(level, twist, flick, raise) {
  calibration = computeCalibration(level, twist, flick, raise, CONFIG);
  detector = createDetector(calibration, CONFIG);
  raiser = calibration.raiseSign ? createRaiseDetector(calibration, CONFIG) : null;
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
    missedFlick: detector ? detector.state.missedFlick : null,
    lift: raiser ? raiser.state.lift : null,
    listening: voice !== null && voice.micOn,
    heard: voice ? voice.heard : '',
    hasKey: deepgramKey !== '',
    tapCheck: { ...tapCheck },
  };
}

/** The Deepgram key typed into the page ('' forgets it). Kept in this variable only. */
export function setDeepgramKey(key) {
  deepgramKey = String(key || '').trim();
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
  if (raiser) {
    const change = raiser.update(sample);
    if (change === 'raise') setTimeout(startVoice, 0);
    else if (change === 'lower') setTimeout(endVoice, 0);
  }
  if (detector && !voice) send(detector.update(sample));   // gestures pause while the microphone is on
}

function onTap(kind, event) {
  if (kind === 'tap') lastTapTime = event.t;
  else {
    tapCheck.doubleTaps += 1;
    if (event.t - lastTapTime <= CONFIG.tapCheckMs) tapCheck.withTapBefore += 1;
  }
  if (detector && !recording && !voice) send(detector.tap(kind, event.t));
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

// ---- Raise to talk --------------------------------------------------------------------
// Raise: microphone on, sound to Deepgram, gestures paused. The command is sent once: when
// the speaker has stopped for CONFIG.voiceEndMs, or when the arm is level again.

async function startVoice() {
  if (voice || !band) return;
  if (!deepgramKey) { note('Raise to talk needs a Deepgram key: paste it into the key field.'); return; }
  const session = { link: null, micOn: false, finals: [], heard: '', endTimer: 0, maxTimer: 0, closing: false };
  voice = session;
  session.link = deepgramLink({ key: deepgramKey });
  session.link.start({
    onText: ({ final, text }) => {
      clearTimeout(session.endTimer);
      if (final) {
        session.finals.push(text);
        session.endTimer = setTimeout(() => closeVoice(session), CONFIG.voiceEndMs);
      }
      session.heard = [...session.finals, final ? '' : text].join(' ').trim();
    },
    onState: (state) => { if (state === 'off') finishVoice(session); },
    onError: (problem) => {
      note(VOICE_PROBLEMS[problem] || 'Deepgram stopped.');
      finishVoice(session);
    },
  });
  session.maxTimer = setTimeout(() => closeVoice(session), CONFIG.voiceMaxMs);
  try {
    await band.configure({ audio: true });       // the band's light goes solid blue
    session.micOn = true;
    if (session.closing) await micOff(session);  // the arm came down while it was starting
  } catch (e) {
    note(e.message);
    closeVoice(session);
  }
}

/** The arm is level again (or the link dropped). */
function endVoice() {
  if (voice) closeVoice(voice);
}

/** Stop listening: microphone off, ask Deepgram for the last words. finishVoice() follows. */
async function closeVoice(session) {
  if (session.closing) return;
  session.closing = true;
  clearTimeout(session.endTimer);
  clearTimeout(session.maxTimer);
  if (session.micOn) await micOff(session);
  session.link.stop();                           // answers with state 'off' once the last words are in
}

async function micOff(session) {
  session.micOn = false;
  if (!band) return;
  try {
    await band.configure({ audio: false });
    await restoreLed();                          // the microphone's blue light is gone: show our colour again
  } catch (e) {
    if (e.code !== 'not-connected') note(e.message);
  }
}

/** Deepgram has closed: send the one command, unless nothing was said. */
function finishVoice(session) {
  if (voice !== session) return;
  clearTimeout(session.endTimer);
  clearTimeout(session.maxTimer);
  if (!session.closing) { session.closing = true; if (session.micOn) micOff(session); }
  voice = null;
  const text = session.finals.join(' ').trim();
  if (text) send([{ type: 'command', text }]);
}

const VOICE_PROBLEMS = {
  refused: 'Deepgram refused the connection: a wrong key, no credit left, or no internet.',
  closed: 'Deepgram closed the connection.',
  reported: 'Deepgram reported a problem.',
  'no-key': 'Raise to talk needs a Deepgram key: paste it into the key field.',
  'no-socket': 'This browser cannot open the connection to Deepgram.',
};
