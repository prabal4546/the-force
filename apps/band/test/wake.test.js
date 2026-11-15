// Tests for wake.js: the wake word and push to talk, fed with text as Deepgram sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../gestures.js';
import { cleanCommand, createWakeListener, findWake } from '../wake.js';

const WAKE = { type: 'wake' };
const command = (text) => ({ type: 'command', text });

test('every wake word in CONFIG is found, whatever the case', () => {
  for (const word of CONFIG.wakeWords) {
    assert.ok(findWake(`ok ${word.toUpperCase()} do it`), word);
  }
  assert.ok(findWake('Vex-oh, lights'));
  assert.equal(findWake('the vexation of taxes'), null);
  assert.equal(findWake('turn on the lamp'), null);
});

test("\"vexo's\" is taken whole, so the command does not start with 's", () => {
  const hit = findWake("Vexo's turn on the lamp");
  assert.equal(cleanCommand("Vexo's turn on the lamp".slice(hit.end)), 'turn on the lamp');
});

test('wake word and command in one sentence: one wake, one command', () => {
  const ears = createWakeListener();
  assert.deepEqual(ears.text('Vexo', false, 0), [WAKE]);
  assert.deepEqual(ears.text('Vexo turn on', false, 300), []);
  assert.equal(ears.state.pending, 'turn on');
  assert.deepEqual(ears.text('Vexo, turn on the lamp.', true, 900), []);
  assert.deepEqual(ears.tick(1700), []);                               // 0.8 s of quiet: she may go on
  assert.deepEqual(ears.tick(1800), [command('turn on the lamp.')]);
  assert.equal(ears.state.armed, false);
});

test('a pause after the wake word: the next sentence is the command', () => {
  const ears = createWakeListener();
  assert.deepEqual(ears.text('Vexo.', true, 0), [WAKE]);
  assert.deepEqual(ears.tick(1000), []);
  assert.deepEqual(ears.text('Make it blue', false, 1500), []);
  assert.deepEqual(ears.text('Make it blue.', true, 2100), []);
  assert.deepEqual(ears.tick(3000), [command('Make it blue.')]);
});

test('nothing within 3 seconds of the wake word: no command', () => {
  const ears = createWakeListener();
  ears.text('Texaco.', true, 0);
  assert.deepEqual(ears.tick(2900), []);
  assert.deepEqual(ears.tick(3000), [{ type: 'wake-timeout' }]);
  assert.deepEqual(ears.text('Make it blue.', true, 3500), []);
});

test('speech without the wake word is ignored', () => {
  const ears = createWakeListener();
  assert.deepEqual(ears.text('Turn on the lamp.', true, 0), []);
  assert.deepEqual(ears.tick(5000), []);
});

test('a second wake word within 2 seconds is ignored, a later one counts', () => {
  const ears = createWakeListener();
  assert.deepEqual(ears.text('Vexo lamp.', true, 0), [WAKE]);
  assert.deepEqual(ears.tick(900), [command('lamp.')]);
  assert.deepEqual(ears.text('Vexo fan.', true, 1500), []);
  assert.deepEqual(ears.tick(1900), []);
  assert.deepEqual(ears.text('Vexo fan.', true, 2100), [WAKE]);
  assert.deepEqual(ears.tick(3000), [command('fan.')]);
});

test('words that are never marked finished are sent after a while', () => {
  const ears = createWakeListener();
  ears.text('Vexo next song', false, 0);
  assert.deepEqual(ears.tick(2000), []);
  assert.deepEqual(ears.tick(2600), [command('next song')]);
});

test('a command spoken with a short pause in it arrives as two finished sentences and is sent as one', () => {
  const ears = createWakeListener();
  assert.deepEqual(ears.text('Vexo, can you move this window to that', true, 0), [WAKE]);
  assert.equal(ears.state.pending, 'can you move this window to that');
  assert.deepEqual(ears.tick(400), []);
  assert.deepEqual(ears.text('display', false, 600), []);              // she goes on before the pause is up
  assert.deepEqual(ears.tick(1400), []);
  assert.deepEqual(ears.text('display.', true, 1500), []);
  assert.deepEqual(ears.tick(2300), []);
  assert.deepEqual(ears.tick(2400), [command('can you move this window to that display.')]);
  assert.equal(ears.state.armed, false);
});

test('a command that never stops is sent after 15 seconds at the latest', () => {
  const ears = createWakeListener();
  ears.text('Vexo', false, 0);
  let out = [];
  for (let t = 500; t <= 16000 && out.length === 0; t += 500) { ears.text('and another thing.', true, t); out = ears.tick(t); }
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'command');
});

test('push to talk: everything said while held is one command, no wake word', () => {
  const ears = createWakeListener();
  ears.pushToTalk(true, 0);
  assert.deepEqual(ears.text('Turn it up.', true, 500), []);
  assert.deepEqual(ears.text('A lot', false, 900), []);
  ears.pushToTalk(false, 1000);
  assert.deepEqual(ears.text('A lot.', true, 1300), [command('Turn it up. A lot.')]);
  assert.deepEqual(ears.text('More words.', true, 2000), []);
});

test('push to talk: released with the last words still unfinished, they are sent after the wait', () => {
  const ears = createWakeListener();
  ears.pushToTalk(true, 0);
  ears.text('Next', false, 400);
  ears.pushToTalk(false, 500);
  assert.deepEqual(ears.tick(1000), []);
  assert.deepEqual(ears.tick(1700), [command('Next')]);
});

test('push to talk with nothing said sends nothing', () => {
  const ears = createWakeListener();
  ears.pushToTalk(true, 0);
  ears.pushToTalk(false, 500);
  assert.deepEqual(ears.tick(2000), []);
});
