// Tests for tts.js with a pretend ElevenLabs: no network, no speaker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../gestures.js';
import { createSpeaker } from '../tts.js';

function pretend(status = 200) {
  const calls = [], played = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: status === 200, status, blob: async () => 'sound of ' + JSON.parse(options.body).text };
  };
  return { calls, played, speaker: createSpeaker({ fetch, play: async (sound) => { played.push(sound); } }) };
}

test('a text is asked for once and then played from the cache', async () => {
  const { calls, played, speaker } = pretend();
  await speaker.say('Lamp', 'key');
  await speaker.say('Lamp', 'key');
  await speaker.say('Fan', 'key');
  assert.equal(calls.length, 2);
  assert.deepEqual(played, ['sound of Lamp', 'sound of Lamp', 'sound of Fan']);
});

test('the request follows the ElevenLabs API: key in a header, never in the address', async () => {
  const { calls, speaker } = pretend();
  await speaker.say('Lamp', 'secret-key');
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/' + CONFIG.ttsVoiceId + '?output_format=mp3_44100_128');
  assert.ok(!url.includes('secret-key'));
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['xi-api-key'], 'secret-key');
  assert.deepEqual(JSON.parse(options.body), { text: 'Lamp', model_id: CONFIG.ttsModel });
});

test('no key and an empty text ask for nothing', async () => {
  const { calls, speaker } = pretend();
  await assert.rejects(speaker.say('Lamp', ''), /needs an ElevenLabs key/);
  await speaker.say('   ', 'key');
  assert.equal(calls.length, 0);
});

test('a refusal gives a sentence without the key, and is not kept in the cache', async () => {
  const { calls, speaker } = pretend(401);
  await assert.rejects(speaker.say('Lamp', 'secret-key'), (e) => /does not know this key/.test(e.message) && !e.message.includes('secret-key'));
  await assert.rejects(speaker.say('Lamp', 'secret-key'));
  assert.equal(calls.length, 2);
  assert.equal(speaker.size, 0);
});
