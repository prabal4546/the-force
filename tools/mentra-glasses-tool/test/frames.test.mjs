import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { JpegSplitter, ffmpegArgs, rtmpInput, startFrames, throttleToLive } from '../src/frames.mjs';
import { SessionStore } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';

const quiet = { log() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const events = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

/** A JPEG-shaped buffer: SOI, a body with FF 00 stuffing (and FF D8 FF inside data), EOI. */
const fakeJpeg = (n) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from([n, 0xff, 0x00, 0xd9, 0x12, 0xff, 0x00, n]),
  Buffer.alloc(50 + n, n),
  Buffer.from([0xff, 0xd9]),
]);

async function split(chunks) {
  const frames = [];
  const s = new JpegSplitter((f) => frames.push(f));
  for (const c of chunks) await new Promise((r) => s.write(c, r));
  return frames;
}

test('splitter: back-to-back JPEGs come out whole, however the pipe cuts them', async () => {
  const pictures = [1, 2, 3, 4, 5].map(fakeJpeg);
  const all = Buffer.concat(pictures);
  for (const size of [1, 2, 3, 7, 64, all.length]) {
    const chunks = [];
    for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
    const frames = await split(chunks);
    assert.equal(frames.length, 5, `chunk size ${size}`);
    frames.forEach((f, i) => assert.deepEqual(f, pictures[i]));
  }
});

test('splitter: junk before a picture is skipped; an unfinished picture is not emitted', async () => {
  const frames = await split([Buffer.from('noise'), fakeJpeg(9), fakeJpeg(8).subarray(0, 20)]);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], fakeJpeg(9));
});

test('ffmpeg arguments: every frame by default, or a set number per second; only screenshots come out', () => {
  const all = ffmpegArgs({ input: ['-i', 'in'] });
  assert.ok(all.includes('passthrough'));
  assert.ok(!all.includes('-vf'));
  assert.deepEqual(all.slice(-2), ['image2pipe', 'pipe:1']);
  assert.equal(all.filter((a) => a === '-f').length, 1, 'one output: the JPEG pipe');
  const five = ffmpegArgs({ input: ['-i', 'in'], framesPerSec: 5, quality: 6 });
  assert.ok(five.includes('fps=5'));
  assert.equal(five[five.indexOf('-q:v') + 1], '6');
});

test('RTMP input: listens for the glasses and studies only half a second of stream before starting', () => {
  const args = rtmpInput(1935);
  assert.deepEqual(args.slice(-4), ['-listen', '1', '-i', 'rtmp://0.0.0.0:1935/live/glasses']);
  assert.equal(args[args.indexOf('-analyzeduration') + 1], '500000');
});

test('config: FRAMES_PER_SEC and FRAME_QUALITY are checked', () => {
  assert.equal(readConfig({}).framesPerSec, 0);
  assert.equal(readConfig({}).frameQuality, 4);
  assert.equal(readConfig({ FRAMES_PER_SEC: '10' }).framesPerSec, 10);
  assert.throws(() => readConfig({ FRAMES_PER_SEC: '-1' }), /FRAMES_PER_SEC/);
  assert.throws(() => readConfig({ FRAME_QUALITY: '40' }), /FRAME_QUALITY/);
  assert.throws(() => readConfig({ FRAME_QUALITY: '1' }), /FRAME_QUALITY/);
});

test('a 2-second 15 fps stream becomes 30 screenshots, all sent to the API, and nothing else is kept', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const clip = path.join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  assert.equal(made.status, 0, String(made.stderr));

  const sent = [];
  const paths = new Set();
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    paths.add(u.pathname);
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/v1/devices/connect') return reply(200, { status: 'registered' });
    const file = init.body.get('photo');
    sent.push({ requestId: init.body.get('requestId'), type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return reply(201, { artifact_id: `photo-${sent.length}`, photoUrl: `http://api/photo-${sent.length}` });
  };

  const run = startFrames({
    dataDir: path.join(dir, 'data'), input: ['-i', clip], log: quiet,
    bodyos: { url: 'http://api', deviceId: 'glasses-1', fetchImpl, retryDelayMs: 1, parallel: 4 },
  });
  const result = await run.done;
  assert.equal(result.frames, 30);
  assert.equal(fs.readdirSync(run.store.photosDir).length, 30);
  assert.equal(sent.length, 30);
  for (const p of sent) {
    assert.equal(p.type, 'image/jpeg');
    assert.deepEqual(p.bytes.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
    assert.deepEqual(p.bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
  }
  assert.equal(new Set(sent.map((p) => p.requestId)).size, 30);
  assert.deepEqual([...paths].sort(), ['/v1/devices/connect', '/v1/glasses/photos'], 'photos only: what codex/api takes');
  // The run folder: screenshots, events and latest.jpg (the newest screenshot, for the viewer). No video anywhere.
  assert.deepEqual(fs.readdirSync(run.store.dir).sort(), ['events.jsonl', 'latest.jpg', 'photos']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), [path.basename(run.store.dir)]);
  const latest = fs.readFileSync(path.join(run.store.dir, 'latest.jpg'));
  assert.deepEqual(latest.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
  const log = events(run.store.dir);
  assert.equal(log.filter((e) => e.type === 'bodyos_stored').length, 30);
  assert.equal(log.at(-1).type, 'frames_end');
  assert.deepEqual(result.bodyos, { stored: 30, failed: 0, skipped: 0, pending: 0 });
});

test('FRAMES_PER_SEC=5 on the same video gives 10 pictures', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const run = startFrames({
    dataDir: dir, framesPerSec: 5, log: quiet,
    input: ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2'],
  });
  const result = await run.done;
  assert.equal(result.frames, 10);
  assert.equal(result.bodyos, null);
});

test('without ffmpeg the run ends with a clear message instead of hanging', async () => {
  const warnings = [];
  const dataDir = tmp();
  const run = startFrames({ dataDir, input: ['-i', 'x'], ffmpeg: 'ffmpeg-that-does-not-exist', log: { log() {}, warn: (m) => warnings.push(m) } });
  const result = await run.done;
  assert.equal(result.frames, 0);
  assert.ok(warnings.some((w) => /ffmpeg is not installed/.test(w)));
  assert.deepEqual(fs.readdirSync(dataDir), [path.basename(run.store.dir)], 'only the run folder (with its events)');
});

test('viewer live feed: 30 pictures a second reach it at most once a second, the newest one', async () => {
  const store = new SessionStore(tmp(), 'stream');
  const got = [];
  const live = { event: (_id, e) => got.push(e) };
  const stop = throttleToLive(store, live, 's', 200);
  store.event('frames_start', {});
  for (let i = 1; i <= 30; i += 1) {
    store.event('photo', { n: i });
    await new Promise((r) => setTimeout(r, 10)); // 300 ms in all
  }
  await new Promise((r) => setTimeout(r, 250));
  store.event('frames_end', { frames: 30 });
  stop();
  await store.close();
  const photos = got.filter((e) => e.type === 'photo');
  assert.ok(photos.length >= 2 && photos.length <= 4, `${photos.length} photo events`);
  assert.equal(photos[0].n, 1);
  assert.equal(photos.at(-1).n, 30, 'the newest picture is never held back for good');
  assert.equal(got[0].type, 'frames_start');
  assert.equal(got.at(-1).type, 'frames_end');
});

test('a run started from the viewer shows up on its live page and ends there', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const calls = [];
  const live = { sessionStarted: (i) => calls.push(['start', i.mode]), sessionEnded: (id, x) => calls.push(['end', x.photos]), event: () => {} };
  const run = startFrames({ dataDir: tmp(), framesPerSec: 5, live, log: quiet,
    input: ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '1'] });
  await run.done;
  assert.deepEqual(calls, [['start', 'frames'], ['end', 5]]);
});

test('two runs never send the same requestId (the API refuses a reused one with other bytes)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const ids = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/photos')) ids.push(init.body.get('requestId'));
    return new Response(JSON.stringify({ artifact_id: 'a' }), { status: url.includes('/connect') ? 200 : 201 });
  };
  for (let i = 0; i < 2; i += 1) {
    const run = startFrames({ dataDir: path.join(dir, 'data'), framesPerSec: 5, log: quiet,
      input: ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '1'],
      bodyos: { url: 'http://api', fetchImpl, retryDelayMs: 1 } });
    await run.done;
  }
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
});

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

test('live RTMP stream: the first screenshot is saved within about a second of the stream starting', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const port = await freePort();
  const run = startFrames({ dataDir: tmp(), input: rtmpInput(port), log: quiet });
  let firstAt = null;
  run.store.subscribe((e) => { if (e.type === 'photo') firstAt ??= Date.now(); });
  await new Promise((r) => setTimeout(r, 800)); // ffmpeg starts listening
  const startedAt = Date.now();
  const pub = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'quiet', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '30', '-f', 'flv', `rtmp://127.0.0.1:${port}/live/glasses`]);
  await new Promise((r) => pub.once('close', r));
  const result = await run.done; // the stream ended, so ffmpeg ends by itself
  assert.ok(firstAt, 'no screenshot at all');
  // ffmpeg's default (studying 5 s of stream) made this about 4.5 s.
  assert.ok(firstAt - startedAt < 2000, `first screenshot after ${firstAt - startedAt} ms`);
  assert.ok(result.frames >= 85, `${result.frames} screenshots from 90 frames`);
});
