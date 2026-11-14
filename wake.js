// Wake word logic for the band module. Pure: it sees the text Deepgram sends back and the
// time, and answers with what to do. No band, no network, no timers of its own.
//
//   text(text, final, now)   the sentence so far (final: Deepgram marked it finished)
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
  let armed = null;                // after a wake word: { since, pending, lastTextAt }
  let lastWakeAt = -Infinity;
  let held = null;                 // push to talk: { parts, interim, flushAt }
  const state = { armed: false, pending: '', held: false };

  function show() {
    state.armed = armed !== null;
    state.pending = held ? [...held.parts, held.interim].join(' ').trim() : armed ? armed.pending : '';
    state.held = held !== null && held.flushAt === null;
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
      armed = { since: now, pending: '', lastTextAt: now };
      out.push({ type: 'wake' });
    }
    // The command is what follows the wake word; a sentence without it follows an earlier "Vexo."
    const said = cleanCommand(hit ? sentence.slice(hit.end) : sentence);
    armed.pending = said;
    armed.lastTextAt = now;
    if (final && said) {
      armed = null;
      out.push({ type: 'command', text: said });
    }
    show();
    return out;
  }

  function tick(now) {
    let out = [];
    if (held && held.flushAt !== null && now >= held.flushAt) out = flushHeld();
    if (armed && !armed.pending && now - armed.since >= config.wakeTimeoutMs) {
      armed = null;
      out.push({ type: 'wake-timeout' });
    } else if (armed && armed.pending && now - armed.lastTextAt >= config.wakeStallMs) {
      out.push({ type: 'command', text: armed.pending });
      armed = null;
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
