// Wake word logic for the band module. Pure: it sees the text Deepgram sends back and the
// time, and answers with what to do. No band, no network, no timers of its own.
//
//   text(text, final, now)   the sentence so far (final: Deepgram marked it finished)
//
// After the wake word, a command is everything said until a real pause (wakeEndMs). Deepgram
// marks a sentence finished at every short pause, so "move this window to that ... display"
// arrives as two finished sentences: they are joined, and sent once nothing more follows.
//   tick(now)                call a few times a second, for the timeouts
//   pushToTalk(on, now)      the spacebar: everything said while held is one command
//
// Each call returns a list of { type: 'wake' } (the wake word was heard),
// { type: 'command', text } and { type: 'wake-timeout' } (nothing followed the wake word).

import { CONFIG } from './gestures.js';

/** Where the first wake word is in `text`: { start, end }, or null. Case does not matter. */
export function findWake(text, words = CONFIG.wakeWords) {
  const forms = [...words].sort((a, b) => b.length - a.length)          // "vexo's" before "vexo"
    .map((w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+'));
  const match = new RegExp('(^|[^a-z0-9])(' + forms.join('|') + ')(?![a-z0-9])', 'i').exec(text);
  if (!match) return null;
  const start = match.index + match[1].length;
  return { start, end: start + match[2].length };
}

/** The words of a command, without the punctuation and spaces around them. */
export function cleanCommand(text) {
  return text.replace(/^[\s,.:;!?'"-]+/, '').replace(/\s+/g, ' ').trim();
}

export function createWakeListener(config = CONFIG) {
  let armed = null;                // after a wake word: { since, parts, interim, lastTextAt }
  let lastWakeAt = -Infinity;
  let held = null;                 // push to talk: { parts, interim, flushAt }
  const state = { armed: false, pending: '', held: false };

  function show() {
    state.armed = armed !== null;
    state.pending = held ? [...held.parts, held.interim].join(' ').trim() : armed ? pending() : '';
    state.held = held !== null && held.flushAt === null;
  }

  /** What has been said since the wake word: the finished sentences and the one still being spoken. */
  const pending = () => [...armed.parts, armed.interim].filter(Boolean).join(' ');

  function sendArmed() {
    const said = pending();
    armed = null;
    return said ? [{ type: 'command', text: said }] : [];
  }

  function flushHeld() {
    const said = cleanCommand([...held.parts, held.interim].join(' '));
    held = null;
    return said ? [{ type: 'command', text: said }] : [];
  }

  function text(sentence, final, now) {
    let out = [];
    if (held) {                                          // push to talk: no wake word needed
      if (final) { held.parts.push(sentence); held.interim = ''; if (held.flushAt !== null) out = flushHeld(); }
      else held.interim = sentence;
      show();
      return out;
    }
    const hit = findWake(sentence, config.wakeWords);
    if (!armed) {
      if (!hit || now - lastWakeAt < config.wakeIgnoreMs) return out;
      lastWakeAt = now;
      armed = { since: now, parts: [], interim: '', lastTextAt: now };
      out.push({ type: 'wake' });
    }
    // The command is what follows the wake word; a sentence without it follows an earlier "Vexo."
    const said = cleanCommand(hit ? sentence.slice(hit.end) : sentence);
    if (final) { if (said) armed.parts.push(said); armed.interim = ''; } else armed.interim = said;
    if (said) armed.lastTextAt = now;                    // still talking: the pause starts again
    show();
    return out;                                          // the command itself is sent by tick(), after the pause
  }

  function tick(now) {
    let out = [];
    if (held && held.flushAt !== null && now >= held.flushAt) out = flushHeld();
    if (armed && !pending()) {
      if (now - armed.since >= config.wakeTimeoutMs) { armed = null; out.push({ type: 'wake-timeout' }); }
    } else if (armed) {
      const quiet = now - armed.lastTextAt;
      // Finished sentences and then a pause: the command is over. Words never marked finished: wait longer.
      if (quiet >= (armed.interim ? config.wakeStallMs : config.wakeEndMs) || now - armed.since >= config.wakeMaxMs) out = sendArmed();
    }
    show();
    return out;
  }

  function pushToTalk(on, now) {
    if (on) { if (!held || held.flushAt !== null) held = { parts: [], interim: '', flushAt: null }; armed = null; }
    else if (held && held.flushAt === null) held.flushAt = now + config.pushToTalkFlushMs;
    show();
  }

  return { text, tick, pushToTalk, state };
}
