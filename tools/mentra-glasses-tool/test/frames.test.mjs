import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JpegSplitter, ffmpegArgs, startFrames } from '../src/frames.mjs';
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

test('ffmpeg arguments: every frame by default, or a set number per second; recording optional', () => {
  const all = ffmpegArgs({ input: ['-i', 'in'] });
  assert.ok(all.includes('passthrough'));
  assert.ok(!all.includes('-vf'));
  assert.deepEqual(all.slice(-2), ['image2pipe', 'pipe:1']);
  const five = ffmpegArgs({ input: ['-i', 'in'], framesPerSec: 5, recordingFile: 'r.mp4', quality: 6 });
  assert.ok(five.includes('fps=5'));
  assert.ok(five.includes('r.mp4'));
  assert.equal(five[five.indexOf('-q:v') + 1], '6');
});

test('config: FRAMES_PER_SEC and FRAME_QUALITY are checked', () => {
  assert.equal(readConfig({}).framesPerSec, 0);
  assert.equal(readConfig({}).frameQuality, 4);
  assert.equal(readConfig({ FRAMES_PER_SEC: '10' }).framesPerSec, 10);
  assert.throws(() => readConfig({ FRAMES_PER_SEC: '-1' }), /FRAMES_PER_SEC/);
  assert.throws(() => readConfig({ FRAME_QUALITY: '40' }), /FRAME_QUALITY/);
  assert.throws(() => readConfig({ FRAME_QUALITY: '1' }), /FRAME_QUALITY/);
});

test('a 2-second 15 fps video becomes 30 pictures and a recording, all sent to the API', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const clip = path.join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  assert.equal(made.status, 0, String(made.stderr));

  const sent = { photo: [], video: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/v1/devices/connect') return reply(200, { status: 'registered' });
    const kind = u.pathname.endsWith('/photos') ? 'photo' : 'video';
    const file = init.body.get(kind);
    sent[kind].push({ requestId: init.body.get('requestId'), type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return reply(201, { artifact_id: `${kind}-${sent[kind].length}`, [`${kind}Url`]: `http://api/${kind}-${sent[kind].length}` });
  };

  const run = startFrames({
    dataDir: path.join(dir, 'data'), input: ['-i', clip], log: quiet,
    bodyos: { url: 'http://api', deviceId: 'mentra-live', fetchImpl, retryDelayMs: 1, parallel: 4 },
  });
  const result = await run.done;
  assert.equal(result.frames, 30);
  assert.equal(fs.readdirSync(run.store.photosDir).length, 30);
  assert.equal(sent.photo.length, 30);
  for (const p of sent.photo) {
    assert.equal(p.type, 'image/jpeg');
    assert.deepEqual(p.bytes.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
    assert.deepEqual(p.bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
  }
  assert.equal(new Set(sent.photo.map((p) => p.requestId)).size, 30);
  assert.equal(sent.video.length, 1);
  assert.equal(sent.video[0].type, 'video/mp4');
  assert.deepEqual(sent.video[0].bytes, fs.readFileSync(path.join(run.store.dir, 'recording.mp4')));
  const log = events(run.store.dir);
  assert.equal(log.filter((e) => e.type === 'bodyos_stored').length, 31);
  assert.equal(log.at(-1).type, 'frames_end');
  assert.deepEqual(result.bodyos, { stored: 31, failed: 0, skipped: 0, pending: 0 });
});

test('FRAMES_PER_SEC=5 on the same video gives 10 pictures', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const run = startFrames({
    dataDir: dir, record: false, framesPerSec: 5, log: quiet,
    input: ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2'],
  });
  const result = await run.done;
  assert.equal(result.frames, 10);
  assert.equal(result.bodyos, null);
});

test('without ffmpeg the run ends with a clear message instead of hanging', async () => {
  const warnings = [];
  const run = startFrames({ dataDir: tmp(), input: ['-i', 'x'], ffmpeg: 'ffmpeg-that-does-not-exist', log: { log() {}, warn: (m) => warnings.push(m) } });
  const result = await run.done;
  assert.equal(result.frames, 0);
  assert.ok(warnings.some((w) => /ffmpeg is not installed/.test(w)));
});

test('each run gives its recording its own API requestId', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const clip = path.join(dir, 'clip.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const ids = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/videos')) ids.push(init.body.get('requestId'));
    return new Response(JSON.stringify({ artifact_id: 'a' }), { status: url.includes('/connect') ? 200 : 201 });
  };
  for (let i = 0; i < 2; i += 1) {
    const run = startFrames({ dataDir: path.join(dir, 'data'), input: ['-i', clip], framesPerSec: 1, log: quiet,
      bodyos: { url: 'http://api', fetchImpl, retryDelayMs: 1 } });
    await run.done;
    await new Promise((r) => setTimeout(r, 5)); // folder names are per millisecond
  }
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});
