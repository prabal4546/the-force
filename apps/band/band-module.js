// Band module for the universal remote: wrist gestures and voice in, messages out.
// Transport-free: the hub glue calls onEvent() and handle(); nothing here knows which
// device is active. The page hands in a connected band with attach(band).

import { CONFIG, checkPose, createDetector, computeCalibration } from './gestures.js';
import { createWakeListener } from './wake.js';
import { deepgramLink } from './speech.js';
import { createSpeaker } from './tts.js';

export { CONFIG, checkPose };

const STORAGE_KEY = 'vexo-band-calibration';
const listeners = new Set();       // outgoing messages
const noteListeners = new Set();   // short sentences for the person (problems, hints)
const signalListeners = new Set(); // moments the page shows or plays: 'wake', 'wake-timeout', 'error', 'active'

let band = null;
let calibration = loadCalibration();
let detector = calibration ? createDetector(calibration, CONFIG) : null;
let recording = null;              // samples of the calibration pose being recorded
let calibrating = false;           // the calibration steps are on screen: no gestures meanwhile
let outbox = [];                   // messages waiting to leave the motion handler
let active = null;                 // the hub's active device: { device, color }
let lastFlash = 0;
let flashing = false;
let lastTapTime = -Infinity;
let slowedDown = false;            // motion was lowered after dropped stream data
const tapCheck = { doubleTaps: 0, withTapBefore: 0 };

// Voice
let deepgramKey = '';              // handed in by the page; never stored here
let muted = false;
let micOn = false;                 // the band's microphone is on (its light is locked blue)
let micStatus = 'off';             // 'off' | 'no-key' | 'starting' | 'listening' | 'muted' | 'error'
let micGainDb = CONFIG.micGainDb;
let loudness = null;               // the band's own loudness reading, dB below full scale (smaller = louder)
let link = null;                   // the open connection to Deepgram
let heard = '';                    // the newest text from Deepgram
let wakeTimer = 0;
let micQueue = Promise.resolve();  // microphone changes run one after another
const wake = createWakeListener(CONFIG);
let reconnects = 0;                // times the Deepgram link was reopened since the last person's action

// Speaking
let elevenLabsKey = '';            // handed in by the page; never stored here
let speaking = 0;                  // texts being spoken now: the microphone would hear them
const speaker = createSpeaker();

// ---- The module interface -------------------------------------------------------------

/** Call `callback(message)` for each outgoing message. Returns a function that stops it. */
export function onEvent(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Accept an incoming message from the hub.
 * While the microphone is on the band's light is locked blue, so the active device and
 * errors are shown on the page (onSignal) and no LED command is sent.
 */
export function handle(message) {
  if (!message) return;
  if (message.type === 'active') {
    active = { device: String(message.device ?? ''), color: typeof message.color === 'string' ? message.color : null };
    signal('active');
    showColour();
  } else if (message.type === 'error') {
    signal('error');
    blinkError();
  } else if (message.type === 'say') {
    speak(message.text);
  }
}

// ---- For the page ---------------------------------------------------------------------

/** Call `callback(text)` with sentences meant for the person. */
export function onNote(callback) {
  noteListeners.add(callback);
  return () => noteListeners.delete(callback);
}

/** Call `callback(kind)` at moments to show or play: 'wake', 'wake-timeout', 'error', 'active'. */
export function onSignal(callback) {
  signalListeners.add(callback);
  return () => signalListeners.delete(callback);
}

/** Start working with a connected band: 100 samples a second, both sensors, events, microphone. */
export async function attach(connectedBand) {
  band = connectedBand;
  slowedDown = false;
  band.on('motion', onMotion);
  band.on('tap', (e) => onTap('tap', e));
  band.on('double-tap', (e) => onTap('double-tap', e));
  band.on('audio', (a) => { if (link) link.packet(a.opus); });
  band.on('mic-level', (e) => { loudness = e.rmsDb; });
  band.on('notice', onNotice);
  band.on('disconnect', () => { band = null; recording = null; micOn = false; loudness = null; closeLink(); micStatus = 'off'; });
  await band.configure({ motion: CONFIG.motionRate, sensors: 'both', events: true });
  changeMic();
}

/** The calibration steps are being shown (true) or are over (false). Gestures pause meanwhile. */
export function setCalibrating(on) {
  calibrating = Boolean(on);
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

/** Work out and save the calibration from the recorded poses (no swipe for the tilt). Throws with a sentence to show. */
export function finishCalibration(level, twist, swipe) {
  calibration = computeCalibration(level, twist, swipe || null, CONFIG);
  detector = createDetector(calibration, CONFIG);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration)); } catch { /* no storage: keep it in memory */ }
  return calibration;
}

/** Everything the page shows. */
export function getState() {
  const d = detector ? detector.state : null;
  return {
    connected: band !== null,
    calibration,
    clutch: d ? d.clutch : false,
    angle: d ? d.angle : null,
    calm: d ? d.calm : false,              // level and still long enough for a gesture to start
    moving: d ? d.moving : false,          // a movement is being looked at
    twisting: d ? d.twisting : false,
    limitRight: d ? d.limitRight : null,   // tilt: how far a tip must go right now, each way
    limitLeft: d ? d.limitLeft : null,
    why: d ? d.why || null : null,          // tilt: why nothing can fire right now, or null
    centre: d && d.centre !== undefined ? d.centre : null,
    armRate: d && d.armRate !== undefined ? d.armRate : null,
    missed: d ? d.missed : null,           // why the last movement was not counted, or null
    movement: d ? d.movement : null,       // how the last movement was judged
    roll: d ? d.roll : null,
    twistRate: d ? d.twistRate : 0,
    swipeRate: d ? d.swipeRate : 0,
    swipeMin: d ? d.swipeMin : CONFIG.swipeMinDps,
    motionRate: slowedDown ? CONFIG.motionFallbackRate : CONFIG.motionRate,
    tapCheck: { ...tapCheck },
    active,
    mic: { status: micStatus, on: micOn, muted, gainDb: micGainDb, loudness },
    wake: { ...wake.state },
    heard,
    hasKey: deepgramKey !== '',
    hasSpeechKey: elevenLabsKey !== '',
    speaking: speaking > 0,
    tapDelay: CONFIG.tapBeforeDoubleTap,
  };
}

/** The Deepgram key typed into the page ('' forgets it). Kept in this variable only. */
export function setDeepgramKey(key) {
  const next = String(key || '').trim();
  if (next === deepgramKey) return;
  deepgramKey = next;
  reconnects = 0;
  changeMic(true);
}

/** The ElevenLabs key typed into the page ('' forgets it). Kept in this variable only. */
export function setElevenLabsKey(key) {
  elevenLabsKey = String(key || '').trim();
}

/** The mute button: true turns the band's microphone off, false turns it back on. */
export function setMuted(on) {
  muted = Boolean(on);
  reconnects = 0;
  changeMic();
}

/** Try another microphone gain (dB, -20 to +20) while tuning. CONFIG.micGainDb is the one used at connect. */
export async function setMicGain(db) {
  micGainDb = Math.max(-20, Math.min(20, Math.round(Number(db) * 2) / 2));
  if (!band) return;
  try { await band.setMicGain(micGainDb); } catch (e) { note(e.message); }
}

/** Push to talk (the spacebar): while on, everything said is one command, no wake word needed. */
export function pushToTalk(on) {
  if (on && !link) { note(muted ? 'The microphone is muted.' : 'The microphone is not on yet.'); return; }
  wake.pushToTalk(on, Date.now());
  if (!on && link) link.restart();                 // asks Deepgram to finish the sentence now
}

// ---- Inside: gestures -----------------------------------------------------------------

function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    // Saves from before the swipe (version 3) do not fit: calibrate again.
    // The turn and the tilt need no swipe axis; the other modes do.
    const fits = saved && saved.version === 3 && Array.isArray(saved.twistVec) && Array.isArray(saved.gravity)
      && (CONFIG.gestures === 'tilt' || CONFIG.gestures === 'turn' || Array.isArray(saved.swipeVec));
    return fits ? saved : null;
  } catch { return null; }                         // no storage (tests) or a broken entry
}

// Runs 100 times a second: collect and detect only, everything slow happens later.
function onMotion(sample) {
  if (recording) { recording.push(sample); return; }
  if (detector && !calibrating) send(detector.update(sample));
}

function onTap(kind, event) {
  if (kind === 'tap') lastTapTime = event.t;
  else {
    tapCheck.doubleTaps += 1;
    if (event.t - lastTapTime <= CONFIG.tapCheckMs) tapCheck.withTapBefore += 1;
    // The check from the real band: no tap before any double-tap means toggle need not wait.
    if (tapCheck.withTapBefore > 0) CONFIG.tapBeforeDoubleTap = true;
    else if (tapCheck.doubleTaps >= CONFIG.tapCheckCount) CONFIG.tapBeforeDoubleTap = false;
  }
  if (detector && !recording && !calibrating) send(detector.tap(kind, event.t));
}

// The link could not keep up (motion and sound share it): halve the motion rate, once.
function onNotice(notice) {
  if (notice.kind !== 'stream-dropped' || slowedDown || !band) return;
  slowedDown = true;
  note('The link dropped stream data: motion lowered to ' + CONFIG.motionFallbackRate + ' samples a second.');
  band.configure({ motion: CONFIG.motionFallbackRate }).catch((e) => note(e.message));
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

function signal(kind) {
  for (const listener of signalListeners) listener(kind);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Inside: the LED. Only while the microphone is off; with it on the light is locked blue.

async function showColour() {
  if (!band || micOn) return;
  try {
    if (active && active.color) await band.setLed(active.color); else await band.ledOff();
  } catch (e) {
    if (e.code !== 'denied' && e.code !== 'not-connected') note(e.message);
  }
}

/** A short white flash, then back to our colour. Never more often than CONFIG.flashGapMs. */
async function flash() {
  const now = Date.now();
  if (!band || micOn || flashing || now - lastFlash < CONFIG.flashGapMs) return;
  flashing = true;
  lastFlash = now;
  try {
    await band.setLed('#ffffff');
    await pause(CONFIG.flashMs);
  } catch (e) {
    if (e.code !== 'denied' && e.code !== 'not-connected') note(e.message);   // denied: the microphone owns the light
  }
  await showColour();
  flashing = false;
}

/** An error from the hub: blink red, then our colour again. The page shows it too. */
async function blinkError() {
  if (!band || micOn || flashing) return;          // microphone on: the light is locked blue
  flashing = true;
  try {
    for (let i = 0; i < CONFIG.errorBlinks; i++) {
      await band.setLed('#ff0000');
      await pause(CONFIG.errorBlinkMs);
      await band.ledOff();
      await pause(CONFIG.errorBlinkMs);
    }
  } catch (e) {
    if (e.code !== 'denied' && e.code !== 'not-connected') note(e.message);
  }
  await showColour();
  flashing = false;
}

/** Speak a text through this computer's speaker. The wake word is deaf meanwhile. */
async function speak(text) {
  speaking += 1;
  try {
    await speaker.say(text, elevenLabsKey);
  } catch (e) {
    note(e.message);
  }
  setTimeout(() => { speaking -= 1; }, 400);       // the room's echo and Deepgram's delay
}

// ---- Inside: voice --------------------------------------------------------------------
// The microphone is on from connect and its sound goes to Deepgram the whole time. A wake
// word ("Vexo ...") or the spacebar turns what is said into one command message.

/** Bring the microphone to where it should be now. `restart` reconnects even if it is on (a new key). */
function changeMic(restart = false) {
  micQueue = micQueue.then(async () => {
    const wanted = band !== null && !muted && deepgramKey !== '';
    if (micOn && (!wanted || restart)) await micOff();
    if (!band) micStatus = 'off';
    else if (muted) micStatus = 'muted';
    else if (!deepgramKey) { micStatus = 'no-key'; note('Voice needs a Deepgram key: paste it into the key field.'); }
    else if (!micOn) await micStart();
  }).catch((e) => note(e.message));
}

async function micStart() {
  micStatus = 'starting';
  const mine = deepgramLink({ key: deepgramKey });
  link = mine;
  mine.start({
    onText: ({ final, text }) => {
      if (speaking > 0 && !wake.state.held) return;       // our own voice from the speaker
      heard = text;
      voice(wake.text(text, final, Date.now()));
    },
    onState: (state) => { if (state === 'listening' && link === mine) micStatus = 'listening'; },
    onError: (problem) => {                        // Deepgram stopped by itself
      if (link !== mine) return;
      link = null;
      if (problem === 'closed' && reconnects < 5) {       // it was working: open it again, a few times at most
        reconnects += 1;
        micStatus = 'starting';
        setTimeout(() => changeMic(true), 2000);
        return;
      }
      note((VOICE_PROBLEMS[problem] || 'Deepgram stopped.') + ' Press Unmute to try again.');
      micQueue = micQueue.then(async () => { await micOff(); micStatus = 'error'; muted = true; });
    },
  });
  try {
    await band.setMicGain(micGainDb);
    await band.configure({ audio: true, micLevel: true });   // the band's light goes solid blue
    micOn = true;
    wakeTimer = setInterval(() => voice(wake.tick(Date.now())), 200);
  } catch (e) {
    closeLink();
    micStatus = 'error';
    throw e;
  }
}

async function micOff() {
  closeLink();
  micOn = false;
  loudness = null;
  if (!band) return;
  try {
    await band.configure({ audio: false, micLevel: false });
  } catch (e) {
    if (e.code !== 'not-connected') note(e.message);
  }
  await showColour();                              // the blue light is gone: show our colour again
}

function closeLink() {
  clearInterval(wakeTimer);
  wake.pushToTalk(false, Date.now());
  if (link) link.stop();
  link = null;
}

function voice(events) {
  for (const event of events) {
    if (event.type === 'command') send([{ type: 'command', text: event.text }]);
    else signal(event.type);                       // 'wake' or 'wake-timeout'
  }
}

const VOICE_PROBLEMS = {
  refused: 'Deepgram refused the connection: a wrong key, no credit left, or no internet.',
  closed: 'Deepgram closed the connection.',
  reported: 'Deepgram reported a problem.',
  'no-key': 'Voice needs a Deepgram key: paste it into the key field.',
  'no-socket': 'This browser cannot open the connection to Deepgram.',
};
