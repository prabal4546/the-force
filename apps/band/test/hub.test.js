// Tests for hub.js against the device API contract (the-force, branch codex/api, docs/api.md).
// A pretend API stands in for the real one.  Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HUB, bandDeviceId, contractProblem, createHubLink } from '../hub.js';
import { CONFIG, computeCalibration, createDetector } from '../gestures.js';

/** A pretend device API. `answers` are used first, one per request; then it behaves like the real one. */
function pretendApi(answers = []) {
  const calls = [];
  let registered = false;
  const post = async (path, body, headers) => {
    calls.push({ path, body, headers });
    const next = answers.shift();
    if (next === 'down') throw new Error('nothing answered');
    if (next) return next;
    if (path === '/v1/devices/connect') { registered = true; return { status: 200, body: { ...body, status: 'registered' } }; }
    if (!registered) return { status: 404, body: { detail: 'Device is not registered; call /v1/devices/connect first' } };
    return { status: 202, body: { status: 'accepted', event_id: headers['Idempotency-Key'], device_id: 'vexo-28' } };
  };
  return { post, calls, forget: () => { registered = false; } };
}

/** A link on the pretend API with a clock that only moves when told to. */
function link(api, more = {}) {
  const clock = { t: 0 };
  const hub = createHubLink({ post: api.post, deviceId: 'vexo-28', now: () => clock.t, wait: async (ms) => { clock.t += ms; }, ...more });
  return { hub, clock };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const events = (api) => api.calls.filter((c) => c.path.startsWith('/v1/band/events'));

test('the device ID is the band number, as in the API examples', () => {
  assert.equal(bandDeviceId(28), 'vexo-28');
  assert.throws(() => createHubLink({ post: async () => ({}), deviceId: 'vexo 28' }), /letters, numbers/);
});

test('every body in the contract table passes, exactly as written there', () => {
  for (const body of [
    { type: 'step', direction: 1 }, { type: 'step', direction: -1 },
    { type: 'toggle' }, { type: 'select' }, { type: 'command', text: 'set a ten minute timer' },
  ]) assert.equal(contractProblem(body), null, JSON.stringify(body));
});

test('what the API would answer 422 to is caught before it is sent', () => {
  const bad = [
    [{ type: 'say', text: 'Lamp' }, /not a band event/],                // say goes the other way
    [{ type: 'step', direction: '1' }, /-1 or 1/],                      // no string for a number
    [{ type: 'step', direction: 0 }, /-1 or 1/],
    [{ type: 'step', direction: true }, /-1 or 1/],
    [{ type: 'step' }, /-1 or 1/],
    [{ type: 'adjust', delta: 0.05 }, /not a band event/],             // taken out of the contract
    [{ type: 'toggle', at: 12 }, /may not carry "at"/],                 // no extra fields
    [{ type: 'select', device: 'lamp' }, /may not carry/],
    [{ type: 'command', text: '   ' }, /not blank/],
    [{ type: 'command', text: 'x'.repeat(4001) }, /longer than 4000/],
    [{ type: 'command' }, /not blank/],
    [null, /not an object/],
  ];
  for (const [body, why] of bad) assert.match(contractProblem(body), why, JSON.stringify(body));
  assert.equal(contractProblem({ type: 'command', text: 'x'.repeat(HUB.maxTextLength) }), null);
});

test('the schema file kept from the API repository lists the same five events', () => {
  const schema = JSON.parse(readFileSync(new URL('../contract/band-input.schema.json', import.meta.url), 'utf8'));
  const types = schema.oneOf.map((entry) => entry.properties.type.const).sort();
  assert.deepEqual(types, ['command', 'select', 'step', 'toggle']);
  for (const entry of schema.oneOf) {
    const body = { type: entry.properties.type.const };
    if (body.type === 'step') body.direction = 1;
    if (body.type === 'command') body.text = 'lights on';
    assert.deepEqual(Object.keys(body).sort(), [...entry.required].sort());
    assert.equal(entry.additionalProperties, false);
    assert.equal(contractProblem(body), null);
  }
});

test('everything the gesture detector sends fits the contract, except the adjust of the old twist mode', () => {
  const RAD = Math.PI / 180;
  const at = (t, roll, rate = 0) => ({ t, ax: 0, ay: Math.sin(roll * RAD), az: Math.cos(roll * RAD), gx: rate, gy: 0, gz: 0 });
  const level = Array.from({ length: 200 }, (_, i) => at(i * 10, 0));
  const twist = Array.from({ length: 200 }, (_, i) => at(i * 10, 40 * Math.sin(i / 10 + 0.3), 400 * Math.cos(i / 10 + 0.3)));
  const calibration = computeCalibration(level, twist);
  const sent = [];
  for (const gestures of ['turn', 'tilt', 'leftRight', 'twistAndSwipe']) {
    const detector = createDetector(calibration, { ...CONFIG, gestures });
    let t = 0;
    const feed = (roll, rate, ms) => { for (let i = 0; i < ms / 10; i++) { t += 10; sent.push(...detector.update(at(t, roll, rate))); } };
    feed(0, 0, 500);
    for (let roll = 0; roll <= 60; roll += 2) feed(roll, 200, 10);
    feed(60, 0, 400);
    for (let roll = 60; roll >= -60; roll -= 2) feed(roll, -200, 10);
    feed(-60, 0, 400);
    sent.push(...detector.tap('tap', t), ...detector.tap('double-tap', t + 100));
    feed(-60, 0, 1500);
    sent.push(...detector.tap('tap', t));
    feed(-60, 0, 800);
  }
  const kinds = new Set(sent.map((m) => m.type));
  for (const kind of ['step', 'adjust', 'toggle', 'select']) assert.ok(kinds.has(kind), 'the detector made a ' + kind);
  for (const message of sent) {
    if (message.type === 'adjust') assert.match(contractProblem(message), /not a band event/);      // twistAndSwipe only: not sent on
    else assert.equal(contractProblem(message), null, JSON.stringify(message));
  }
});

test('register tells the API the band is connected, in the shape it asks for', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  assert.equal(await hub.register('connected'), true);
  assert.deepEqual(api.calls[0], { path: '/v1/devices/connect', body: { device_id: 'vexo-28', device_type: 'band', hardware_status: 'connected' }, headers: {} });
  assert.equal(hub.state.status, 'ready');
  await hub.register('disconnected');
  assert.equal(api.calls[1].body.hardware_status, 'disconnected');
});

test('an event goes to /v1/band/events with the device in the query, the body untouched and its own key', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  await hub.register('connected');
  hub.send({ type: 'step', direction: 1 });
  hub.send({ type: 'step', direction: 1 });
  hub.send({ type: 'command', text: 'set a ten minute timer' });
  await settle();
  const sent = events(api);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].path, '/v1/band/events?device_id=vexo-28');
  assert.deepEqual(sent[0].body, { type: 'step', direction: 1 });
  assert.deepEqual(sent[2].body, { type: 'command', text: 'set a ten minute timer' });
  const keys = sent.map((c) => c.headers['Idempotency-Key']);
  assert.equal(new Set(keys).size, 3, 'a new key for every event, even two alike');
  for (const key of keys) assert.match(key, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.equal(hub.state.accepted, 3);
  assert.equal(hub.state.dropped, 0);
});

test('events are sent one at a time, in the order they happened', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  await hub.register('connected');
  for (const direction of [1, -1, 1, 1, -1]) hub.send({ type: 'step', direction });
  await settle();
  assert.deepEqual(events(api).map((c) => c.body.direction), [1, -1, 1, 1, -1]);
});

test('a message that does not fit is not sent, and the reason is kept for the page', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  await hub.register('connected');
  assert.equal(hub.send({ type: 'say', text: 'Lamp' }), false);
  await settle();
  assert.equal(events(api).length, 0);
  assert.equal(hub.state.dropped, 1);
  assert.match(hub.state.problem, /does not fit the contract/);
});

test('an API that restarted has forgotten the band: register again, then the same event with the same key', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  await hub.register('connected');
  api.forget();
  hub.send({ type: 'select' });
  await settle();
  assert.deepEqual(api.calls.slice(1).map((c) => c.path.split('?')[0]), ['/v1/band/events', '/v1/devices/connect', '/v1/band/events']);
  assert.equal(api.calls[1].headers['Idempotency-Key'], api.calls[3].headers['Idempotency-Key']);
  assert.equal(api.calls[2].body.hardware_status, 'connected');
  assert.equal(hub.state.accepted, 1);
});

test('no answer once: the same event is tried again under the same key, then sent', async () => {
  const api = pretendApi();
  const { hub } = link(api);
  await hub.register('connected');
  api.calls.length = 0;
  let failed = false;
  const flaky = link({ post: async (...args) => { if (!failed) { failed = true; api.calls.push({ path: args[0], headers: args[2] }); throw new Error('nothing answered'); } return api.post(...args); } });
  flaky.hub.send({ type: 'toggle' });
  await settle();
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].headers['Idempotency-Key'], api.calls[1].headers['Idempotency-Key']);
  assert.equal(flaky.hub.state.accepted, 1);
  assert.equal(flaky.hub.state.status, 'ready');
});

test('no answer at all: the event is dropped after the tries, never sent late', async () => {
  const api = pretendApi(['down', 'down', 'down', 'down']);
  const { hub, clock } = link(api);
  hub.send({ type: 'step', direction: 1 });
  await settle();
  assert.equal(api.calls.length, 1 + HUB.retryMs.length);
  assert.equal(new Set(api.calls.map((c) => c.headers['Idempotency-Key'])).size, 1, 'retries reuse the key');
  assert.equal(hub.state.status, 'unreachable');
  assert.equal(hub.state.dropped, 1);
  assert.equal(hub.state.queued, 0);
  clock.t += 60000;                                                     // much later the API is back
  hub.send({ type: 'step', direction: -1 });
  await settle();
  assert.deepEqual(events(api).slice(-1)[0].body, { type: 'step', direction: -1 });   // only the new one
});

test('an event that waited too long behind others is dropped instead of arriving late', async () => {
  let release;
  const calls = [];
  const post = async (path, body) => {
    calls.push(body);
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return { status: 202, body: {} };
  };
  const clock = { t: 0 };
  const hub = createHubLink({ post, deviceId: 'vexo-28', now: () => clock.t, wait: async () => {} });
  hub.send({ type: 'step', direction: 1 });
  hub.send({ type: 'step', direction: -1 });
  clock.t = HUB.maxAgeMs + 1;                                           // the first request hung for over 3 seconds
  release();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(hub.state.accepted, 1);
  assert.equal(hub.state.dropped, 1);
});

test('a refusal says what to fix: the token, or the body the API did not accept', async () => {
  const noToken = pretendApi([{ status: 401, body: { detail: 'A valid demo session token is required' } }]);
  const first = link(noToken);
  assert.equal(await first.hub.register('connected'), false);
  assert.equal(first.hub.state.status, 'refused');
  assert.match(first.hub.state.problem, /BODYOS_SESSION_TOKEN/);

  const strict = pretendApi();
  const second = link(strict);
  await second.hub.register('connected');
  strict.calls.length = 0;
  const refusing = link(pretendApi([{ status: 422, body: { detail: [{ type: 'extra_forbidden', loc: ['body'], msg: 'Extra inputs are not permitted' }] } }]));
  refusing.hub.send({ type: 'toggle' });
  await settle();
  assert.equal(refusing.hub.state.status, 'refused');
  assert.match(refusing.hub.state.problem, /did not accept \{"type":"toggle"\}/);
  assert.equal(refusing.hub.state.dropped, 1);

  const wrongKind = link(pretendApi([{ status: 409, body: { detail: 'A registered device ID cannot change its device_type' } }]));
  await wrongKind.hub.register('connected');
  assert.match(wrongKind.hub.state.problem, /another kind of device/);
});
