import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiRequestId, bodyosClient, forwardToBodyos, photoType, readBodyosConfig } from '../src/bodyos.mjs';
import { createReceiver } from '../src/receiver.mjs';
import { SessionStore } from '../src/store.mjs';

const quiet = { log() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bodyos-'));
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 3), Buffer.from([0xff, 0xd9])]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(5000, 1)]);
const events = (store) => fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

/**
 * A pretend device API following docs/api.md on codex/api. `script` can make the next photo calls
 * fail: a list of HTTP statuses, used up one per photo call.
 */
function fakeApi({ token = '', script = [] } = {}) {
  const api = { calls: [], devices: new Set(), photos: [] };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  api.fetch = async (url, init) => {
    const u = new URL(url);
    const auth = new Headers(init.headers).get('authorization') ?? '';
    api.calls.push(`${init.method} ${u.pathname}`);
    if (token && auth !== `Bearer ${token}`) return reply(401, { detail: 'Missing or invalid session credentials' });
    if (u.pathname === '/v1/devices/connect') {
      const body = JSON.parse(init.body);
      assert.equal(body.device_type, 'glasses');
      api.devices.add(body.device_id);
      return reply(200, { ...body, status: 'registered' });
    }
    if (u.pathname === '/v1/glasses/photos') {
      const next = script.shift();
      if (next) return reply(next, { detail: `scripted ${next}` });
      const deviceId = u.searchParams.get('device_id');
      if (!api.devices.has(deviceId)) return reply(404, { detail: 'Unknown device' });
      const form = init.body;
      const file = form.get('photo');
      assert.ok(file, 'multipart field "photo" missing');
      const requestId = form.get('requestId');
      assert.ok(requestId.length >= 1 && requestId.length <= 128);
      const bytes = Buffer.from(await file.arrayBuffer());
      api.photos.push({ deviceId, requestId, type: file.type, bytes });
      const id = `photo-${api.photos.length}`;
      return reply(201, { status: 'received', request_id: requestId, device_id: deviceId, artifact_id: id, photoUrl: `http://api/v1/artifacts/${id}` });
    }
    return reply(404, { detail: 'Not Found' });
  };
  return api;
}

const settings = (api, extra = {}) => ({ url: 'http://api', deviceId: 'glasses-1', log: quiet, fetchImpl: api.fetch, retryDelayMs: 1, ...extra });

test('config: off without a URL, checks the URL and the device id', () => {
  assert.equal(readBodyosConfig({}).url, '');
  assert.equal(readBodyosConfig({}).deviceId, 'glasses-1');
  assert.equal(readBodyosConfig({ BODYOS_API_URL: 'http://10.0.0.5:8000/' }).url, 'http://10.0.0.5:8000');
  assert.throws(() => readBodyosConfig({ BODYOS_API_URL: '10.0.0.5:8000' }), /http/);
  assert.throws(() => readBodyosConfig({ BODYOS_DEVICE_ID: '../x' }), /BODYOS_DEVICE_ID/);
});

test('requestId: one per saved file, safe characters, at most 128', () => {
  assert.equal(apiRequestId('bodyos-1a2b', 'photos/photo_000001_17.jpg'), 'bodyos-1a2b-photo_000001_17');
  assert.equal(apiRequestId(undefined, 'photos/photo_000002_18.png'), 'photo_000002_18');
  assert.equal(apiRequestId('a/b?c', 'photos/p.jpg'), 'abc-p');
  assert.ok(apiRequestId('x'.repeat(300), 'photos/photo_000003_19.jpg').length <= 128);
  assert.ok(apiRequestId('x'.repeat(300), 'photos/photo_000003_19.jpg').endsWith('photo_000003_19'));
});

test('each saved photo is registered and kept in the API, and the artifact is written to events.jsonl', async () => {
  const api = fakeApi({ token: 'secret' });
  const store = new SessionStore(tmp(), 't');
  const f = forwardToBodyos(store, settings(api, { token: 'secret', parallel: 1 })); // 1 at a time: in order
  assert.equal(await f.ready, true);
  await store.savePhoto(jpeg(), 'image/jpeg', { requestId: 'glasses-req' });
  await store.savePhoto(jpeg(), 'image/png');
  await f.drain();
  await store.close();
  assert.deepEqual([...api.devices], ['glasses-1']);
  assert.equal(api.photos.length, 2);
  assert.match(api.photos[0].requestId, /^glasses-req-photo_000001_\d+$/);
  assert.equal(api.photos[0].type, 'image/jpeg');
  assert.deepEqual(api.photos[0].bytes, jpeg());
  const kept = events(store).filter((e) => e.type === 'bodyos_stored');
  assert.deepEqual(kept.map((e) => e.artifactId), ['photo-1', 'photo-2']);
  assert.equal(kept[0].url, 'http://api/v1/artifacts/photo-1');
  assert.equal(kept[0].file, events(store).find((e) => e.type === 'photo').file);
  assert.deepEqual(f.stats, { stored: 2, failed: 0, skipped: 0, pending: 0 });
});

test('a busy or unreachable API is retried; after an API restart the glasses are registered again', async () => {
  const api = fakeApi({ script: [503] });
  const store = new SessionStore(tmp(), 't');
  const f = forwardToBodyos(store, settings(api));
  await f.ready;
  await store.savePhoto(jpeg(), 'image/jpeg');
  await f.drain();
  assert.equal(f.stats.stored, 1);

  api.devices.clear(); // the API restarted: registrations are in memory only
  const f2 = forwardToBodyos(store, settings(api));
  await f2.ready;
  api.devices.clear();
  await store.savePhoto(jpeg(), 'image/jpeg');
  await f2.drain();
  await store.close();
  assert.equal(f2.stats.stored, 1);
  assert.ok(api.calls.filter((c) => c === 'POST /v1/devices/connect').length >= 3);
});

test('a wrong token fails at once, visibly, and the local photo stays', async () => {
  const api = fakeApi({ token: 'right' });
  const warnings = [];
  const store = new SessionStore(tmp(), 't');
  const f = forwardToBodyos(store, settings(api, { token: 'wrong', log: { log() {}, warn: (m) => warnings.push(m) } }));
  assert.equal(await f.ready, false);
  const name = await store.savePhoto(jpeg(), 'image/jpeg');
  await f.drain();
  await store.close();
  const failed = events(store).find((e) => e.type === 'bodyos_failed');
  assert.equal(failed.status, 401);
  assert.equal(api.calls.filter((c) => c === 'POST /v1/glasses/photos').length, 0);
  assert.ok(fs.existsSync(path.join(store.photosDir, name)));
  assert.ok(warnings.some((w) => /not reachable yet/.test(w)));
  assert.ok(warnings.some((w) => /copy in data\/ is safe/.test(w)));
});

test('a WebP photo stays local and says why', async () => {
  const api = fakeApi();
  const store = new SessionStore(tmp(), 't');
  const f = forwardToBodyos(store, settings(api));
  await store.savePhoto(Buffer.from('RIFF0000WEBPxxxx'), 'image/webp');
  await f.drain();
  await store.close();
  assert.equal(api.photos.length, 0);
  assert.match(events(store).find((e) => e.type === 'bodyos_skipped').reason, /JPEG and PNG photos only/);
});

test('receiver: a photo from the glasses ends up in data/ and in the API before close() returns', async () => {
  const api = fakeApi();
  const r = await createReceiver({ dataDir: tmp(), port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', log: quiet, bodyos: settings(api) });
  const form = new FormData();
  form.append('requestId', 'from-glasses');
  form.append('photo', new Blob([jpeg()], { type: 'image/jpeg' }), 'p.jpg');
  const res = await fetch(`http://127.0.0.1:${r.port}/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  await r.close();
  assert.equal(api.photos.length, 1);
  assert.match(api.photos[0].requestId, /^from-glasses-photo_000001_/);
  assert.equal(events(r.store).find((e) => e.type === 'bodyos_stored').artifactId, 'photo-1');
});

test('only JPEG and PNG are sent (judged by extension; the API checks the bytes)', () => {
  assert.equal(photoType('a/photo.JPG'), 'image/jpeg');
  assert.equal(photoType('a/p.png'), 'image/png');
  assert.equal(photoType('a/recording.mp4'), null);
  assert.equal(photoType('a/p.webp'), null);
  assert.equal(photoType('a/events.jsonl'), null);
});

test('receiver: a video clip is refused and nothing reaches the API', async () => {
  const api = fakeApi();
  const r = await createReceiver({ dataDir: tmp(), port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', log: quiet, bodyos: settings(api) });
  const form = new FormData();
  form.append('requestId', 'clip-7');
  form.append('video', new Blob([mp4()], { type: 'video/mp4' }), 'clip.mp4');
  const res = await fetch(`http://127.0.0.1:${r.port}/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /screenshots/);
  await r.close();
  assert.equal(api.photos.length, 0);
  assert.equal(api.calls.filter((c) => c.includes('/glasses/')).length, 0);
});

test('send: a screenshot on disk is sent; a rejected one, a video or another file says why', async () => {
  const dir = tmp();
  const file = path.join(dir, 'photo_000001_1.jpg');
  fs.writeFileSync(file, jpeg());
  const api = fakeApi();
  const client = bodyosClient(settings(api));
  const r = await client.send(file, path.basename(dir));
  assert.equal(r.url, 'http://api/v1/artifacts/photo-1');
  assert.equal(r.requestId, `${path.basename(dir).replace(/[^A-Za-z0-9_-]/g, '')}-photo_000001_1`);
  assert.deepEqual(api.photos[0].bytes, jpeg());

  const tooBig = bodyosClient(settings(fakeApi({ script: [413] })));
  await assert.rejects(tooBig.send(file), /HTTP 413/);
  await assert.rejects(client.send(path.join(dir, 'recording.mp4')), /JPEG and PNG photos only/);
  await assert.rejects(client.send(path.join(dir, 'notes.txt')), /only/);
  assert.equal(api.calls.filter((c) => c === 'POST /v1/glasses/photos').length, 1);
});

test('parallel uploads: never more than `parallel` at once, all kept, drain() waits for the last one', async () => {
  const api = fakeApi();
  let inFlight = 0;
  let most = 0;
  const slow = async (url, init) => {
    if (!String(url).includes('/glasses/photos')) return api.fetch(url, init);
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return api.fetch(url, init);
  };
  const store = new SessionStore(tmp(), 't');
  const f = forwardToBodyos(store, settings(api, { fetchImpl: slow, parallel: 4 }));
  await f.ready;
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) await store.savePhoto(jpeg(), 'image/jpeg', { requestId: `frame-${i}` });
  assert.ok(f.stats.pending > 0);
  await f.drain();
  const took = Date.now() - started;
  await store.close();
  assert.equal(api.photos.length, 20);
  assert.equal(most, 4);
  assert.equal(f.stats.pending, 0);
  assert.equal(new Set(api.photos.map((p) => p.requestId)).size, 20);
  assert.ok(took < 20 * 20, `took ${took} ms: not faster than one at a time`);
});

test('config: BODYOS_PARALLEL is 4 by default and checked', () => {
  assert.equal(readBodyosConfig({}).parallel, 4);
  assert.equal(readBodyosConfig({ BODYOS_PARALLEL: '8' }).parallel, 8);
  assert.throws(() => readBodyosConfig({ BODYOS_PARALLEL: '0' }), /BODYOS_PARALLEL/);
  assert.throws(() => readBodyosConfig({ BODYOS_PARALLEL: 'lots' }), /BODYOS_PARALLEL/);
});
