// Text to speech for the band module: ElevenLabs turns a short text into sound, played
// through this computer's speaker. Each text is fetched once and kept, so a repeat plays
// at once. The key is handed in by the page and is never written anywhere by this file.
//
// API (elevenlabs.io/docs/api-reference/text-to-speech/convert, read November 2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
//   header xi-api-key, JSON body { text, model_id }, answers with the audio file.

import { CONFIG } from './gestures.js';

const ADDRESS = 'https://api.elevenlabs.io/v1/text-to-speech/';

/**
 * @param {object} [options] only for the tests: a pretend `fetch` and `play`.
 *   play(blob) resolves when the sound has finished.
 */
export function createSpeaker({ fetch: request = (...a) => globalThis.fetch(...a), play = playBlob, config = CONFIG } = {}) {
  const cache = new Map();         // text -> promise of the sound

  function load(text, key) {
    if (!cache.has(text)) {
      const sound = request(ADDRESS + encodeURIComponent(config.ttsVoiceId) + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: config.ttsModel }),
      }).then((answer) => {
        if (!answer.ok) throw new Error(PROBLEMS[answer.status] || 'ElevenLabs answered with status ' + answer.status + '.');
        return answer.blob();
      });
      cache.set(text, sound);
      sound.catch(() => cache.delete(text));             // a failure is not kept: the next try asks again
    }
    return cache.get(text);
  }

  return {
    /** Speak `text`. Resolves when it has been played; rejects with a sentence to show. */
    async say(text, key) {
      const words = String(text ?? '').trim();
      if (!words) return;
      if (!key) throw new Error('Speaking needs an ElevenLabs key: paste it into the key field.');
      await play(await load(words, key));
    },
    /** How many texts are kept. */
    get size() { return cache.size; },
  };
}

function playBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch((e) => { URL.revokeObjectURL(url); reject(new Error('The browser did not play the sound: ' + e.message)); });
  });
}

// Only the status number decides the sentence: never the text the service sent, never the key.
const PROBLEMS = {
  401: 'ElevenLabs does not know this key. Copy it again: the whole key, no spaces.',
  402: 'The ElevenLabs key has no credit left.',
  404: 'ElevenLabs does not know this voice. Check ttsVoiceId in CONFIG.',
  422: 'ElevenLabs did not accept the request. Check ttsModel and ttsVoiceId in CONFIG.',
  429: 'Too many ElevenLabs requests at once. Wait a few seconds.',
};
