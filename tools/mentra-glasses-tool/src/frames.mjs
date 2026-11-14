// Fast screenshots: as many per second as the glasses can give, each sent to the device API.
//   npm run frames
// Then point the glasses' live stream at the printed RTMP address (Mentra's example app: Stream screen;
// or the SDK route with STREAM=1). Every frame (or FRAMES_PER_SEC of them) becomes a JPEG in
// data/<time>_stream/photos/ and, when BODYOS_API_URL is set, a photo in the API (branch codex/api)
// the moment it is cut. The stream itself is not kept: only the screenshots are.
// latest.jpg in the same folder is the newest screenshot, replaced twice a second (the viewer shows it).
//
// Why not photo commands? Each takes seconds over Bluetooth; the live stream carries 15-30 frames a second.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { forwardToBodyos } from './bodyos.mjs';
import { lanAddress, loadDotEnv, readConfig } from './config.mjs';
import { startLiveFeed } from './live.mjs';
import { SessionStore } from './store.mjs';

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const MAX_FRAME_BYTES = 10 * 1024 * 1024; // the API's photo limit

/**
 * Split a stream of back-to-back JPEGs (ffmpeg's image2pipe) into single JPEGs.
 * A JPEG starts with FF D8 FF and ends at the first FF D9: inside the picture data every FF byte is
 * followed by 00, so FF D9 cannot appear before the end. ffmpeg's encoder writes no thumbnails.
 */
export class JpegSplitter extends Writable {
  constructor(onFrame) {
    super();
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
    this.searchFrom = 2;
    this.dropped = 0;
  }

  _write(chunk, _enc, done) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 2)); // keep a marker split across chunks
        this.searchFrom = 2;
        break;
      }
      if (start > 0) {
        this.buf = this.buf.subarray(start);
        this.searchFrom = 2;
      }
      const end = this.buf.indexOf(0xd9, this.searchFrom);
      if (end < 0) {
        this.searchFrom = Math.max(2, this.buf.length - 1);
        if (this.buf.length > MAX_FRAME_BYTES) this.#drop();
        break;
      }
      if (this.buf[end - 1] !== 0xff) {
        this.searchFrom = end + 1;
        continue;
      }
      const frame = Buffer.from(this.buf.subarray(0, end + 1)); // a copy: the big buffer is reused
      this.buf = this.buf.subarray(end + 1);
      this.searchFrom = 2;
      this.onFrame(frame);
    }
    done();
  }

  #drop() {
    this.dropped += 1;
    this.buf = Buffer.alloc(0);
    this.searchFrom = 2;
  }
}

/**
 * ffmpeg's input: wait for the glasses' RTMP stream on `port`. ffmpeg normally studies the first
 * 5 seconds of a stream before it decodes anything; half a second is plenty for the glasses' H.264,
 * so the first screenshot comes about 4 seconds sooner.
 */
export const rtmpInput = (port) => ['-analyzeduration', '500000', '-listen', '1', '-i', `rtmp://0.0.0.0:${port}/live/glasses`];

/** The ffmpeg arguments: one input, out as back-to-back JPEGs on stdout. */
export function ffmpegArgs({ input, framesPerSec = 0, quality = 4 }) {
  const args = ['-hide_banner', '-loglevel', 'error', ...input, '-map', '0:v'];
  if (framesPerSec > 0) args.push('-vf', `fps=${framesPerSec}`);
  else args.push('-fps_mode', 'passthrough'); // every frame the glasses send, once
  args.push('-c:v', 'mjpeg', '-q:v', String(quality), '-f', 'image2pipe', 'pipe:1');
  return args;
}

/**
 * Pass a store's events to the viewer's live feed, but each kind of event at most once a second
 * (the newest one wins): 30 pictures a second would otherwise make the viewer re-read the folder 30
 * times a second. Start and end events always go through at once.
 */
export function throttleToLive(store, live, sessionId, everyMs = 1000) {
  const always = new Set(['frames_start', 'frames_end']);
  const lastSent = new Map();
  const held = new Map();
  const send = (event) => {
    lastSent.set(event.type, Date.now());
    live.event(sessionId, event);
  };
  const unsubscribe = store.subscribe((event) => {
    if (always.has(event.type) || Date.now() - (lastSent.get(event.type) ?? 0) >= everyMs) send(event);
    else held.set(event.type, event);
  });
  const timer = setInterval(() => {
    for (const [type, event] of held) {
      if (Date.now() - (lastSent.get(type) ?? 0) >= everyMs) {
        held.delete(type);
        send(event);
      }
    }
  }, Math.max(50, everyMs / 4));
  timer.unref();
  return () => {
    unsubscribe();
    clearInterval(timer);
    for (const event of held.values()) live.event(sessionId, event);
    held.clear();
  };
}

/**
 * Start cutting frames. Returns { store, stats, bodyos, done, stop() }.
 * `input` is ffmpeg's input arguments (`rtmpInput(port)`; tests use a generated video).
 * `live` is the viewer's live feed (or null).
 */
export function startFrames({
  dataDir,
  input,
  framesPerSec = 0,
  quality = 4,
  bodyos = null,
  live = null,
  log = console,
  ffmpeg = 'ffmpeg',
}) {
  const store = new SessionStore(dataDir, 'stream');
  const sessionId = path.basename(store.dir);
  const stopLive = live ? throttleToLive(store, live, sessionId) : () => {};
  live?.sessionStarted({ sessionId, user: 'Fast screenshots', mode: 'frames' });
  const forwarder = bodyos?.url ? forwardToBodyos(store, { ...bodyos, log }) : null;
  const latestFile = path.join(store.dir, 'latest.jpg');
  const stats = { frames: 0, bytes: 0, startedAt: null };
  const writes = new Set();
  let latestAt = 0;
  let latestBusy = false;

  /** The newest picture, twice a second, replaced in one step so a reader never sees half a file. */
  function writeLatest(frame) {
    const now = Date.now();
    if (latestBusy || now - latestAt < 500) return;
    latestBusy = true;
    latestAt = now;
    const tmp = `${latestFile}.tmp`;
    const write = fs.promises
      .writeFile(tmp, frame)
      .then(() => fs.promises.rename(tmp, latestFile))
      .catch(() => {})
      .finally(() => {
        latestBusy = false;
        writes.delete(write);
      });
    writes.add(write);
  }

  store.event('frames_start', { framesPerSec: framesPerSec || 'all', quality });
  const child = spawn(ffmpeg, ffmpegArgs({ input, framesPerSec, quality }), { stdio: ['ignore', 'pipe', 'pipe'] });

  const splitter = new JpegSplitter((frame) => {
    stats.frames += 1;
    stats.bytes += frame.length;
    stats.startedAt ??= Date.now();
    const n = stats.frames;
    writeLatest(frame);
    const write = store
      .savePhoto(frame, 'image/jpeg', { reason: 'stream', requestId: `frame-${n}` })
      .catch((err) => log.warn(`frame ${n} not saved: ${err.message}`))
      .finally(() => writes.delete(write));
    writes.add(write);
  });
  child.stdout.pipe(splitter);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (/Error during demuxing: Input\/output error/.test(line)) log.log('The stream ended.'); // glasses stopped streaming
      else log.warn(`ffmpeg: ${line.trim()}`);
    }
  });

  const exited = new Promise((resolve) => {
    child.once('error', (err) => {
      log.warn(err.code === 'ENOENT' ? 'ffmpeg is not installed (macOS: brew install ffmpeg)' : `ffmpeg: ${err.message}`);
      resolve(null);
    });
    child.once('close', (code, signal) => resolve(code ?? signal));
  });

  // When ffmpeg is gone: save the last screenshots, finish uploading, close the folder.
  const done = (async () => {
    const result = await exited;
    await new Promise((resolve) => (splitter.writableFinished ? resolve() : splitter.once('finish', resolve)));
    await Promise.all([...writes]);
    if (forwarder) {
      const left = forwarder.stats.pending;
      if (left) log.log(`Sending the last ${left} screenshots to the device API...`);
      await forwarder.drain();
    }
    store.event('frames_end', { frames: stats.frames, ffmpeg: result });
    stopLive();
    live?.sessionEnded(sessionId, { reason: 'stopped', photos: store.photoCount });
    await store.close();
    return { ffmpeg: result, frames: stats.frames, bodyos: forwarder?.stats ?? null };
  })();

  return {
    store,
    stats,
    bodyos: forwarder,
    done,
    /**
     * Stop listening. A Ctrl+C in a terminal has already reached ffmpeg; give it a moment to pass on
     * the frames it holds, then ask, then insist. Screenshots already cut are saved and sent either way.
     */
    stop({ graceMs = 500 } = {}) {
      const running = () => child.exitCode === null && child.signalCode === null;
      const later = (ms, fn) => setTimeout(() => running() && fn(), ms).unref();
      later(graceMs, () => child.kill('SIGINT'));
      later(graceMs + 5_000, () => child.kill('SIGKILL'));
      return done;
    },
  };
}

async function main() {
  loadDotEnv();
  const cfg = readConfig();
  const port = Number(process.env.RTMP_PORT ?? 1935);
  const rtmpUrl = `rtmp://${lanAddress()}:${port}/live/glasses`;
  let midLine = false; // the progress line has no newline yet
  const say = (fn) => (m) => {
    if (midLine) process.stdout.write('\n');
    midLine = false;
    fn(m);
  };
  const log = { log: say(console.log), warn: say(console.warn) };
  const live = await startLiveFeed(cfg, { mode: 'frames', stream: true, rtmpUrl });
  const run = startFrames({
    log,
    live,
    dataDir: cfg.dataDir,
    input: rtmpInput(port),
    framesPerSec: cfg.framesPerSec,
    quality: cfg.frameQuality,
    bodyos: cfg.bodyos,
  });
  console.log('');
  console.log('Fast screenshots from the glasses\' live stream.');
  console.log(`  Stream to (RTMP):  ${rtmpUrl}   paste this into Mentra's Stream screen (or RTMP_URL with STREAM=1)`);
  console.log(`  Screenshots:       ${cfg.framesPerSec ? `${cfg.framesPerSec} per second` : 'every frame the glasses send'} -> ${run.store.photosDir}`);
  console.log(cfg.bodyos.url
    ? `  Sent to:           device API ${cfg.bodyos.url} (device ${cfg.bodyos.deviceId}), ${cfg.bodyos.parallel} uploads at a time`
    : '  Device API:        off (set BODYOS_API_URL to send every screenshot to the codex/api API)');
  console.log('Waiting for the stream. Ctrl+C to stop.');

  // In a terminal one line updates in place every second; elsewhere (the viewer's log) a new line
  // every 5 seconds.
  const tty = Boolean(process.stdout.isTTY);
  let last = { frames: 0, stored: 0, time: Date.now() };
  const ticker = setInterval(() => {
    const now = Date.now();
    const b = run.bodyos?.stats;
    const rate = ((run.stats.frames - last.frames) * 1000) / (now - last.time);
    const sent = b ? ((b.stored - last.stored) * 1000) / (now - last.time) : 0;
    if (run.stats.frames === 0) return;
    const line = `${run.stats.frames} screenshots (${rate.toFixed(1)}/s)` +
      (b ? `  API: ${b.stored} kept (${sent.toFixed(1)}/s), ${b.pending} waiting, ${b.failed} failed` : '');
    if (tty) {
      process.stdout.write(`\r${line}      `);
      midLine = true;
    } else {
      console.log(line);
    }
    last = { frames: run.stats.frames, stored: b?.stored ?? 0, time: now };
  }, tty ? 1000 : 5000);

  process.once('SIGINT', () => {
    log.log('Stopping...');
    void run.stop();
  });
  process.once('SIGTERM', () => void run.stop({ graceMs: 0 }));
  const result = await run.done;
  clearInterval(ticker);
  await live?.close();
  const b = result.bodyos;
  log.log(`Stopped. ${result.frames} screenshots in ${run.store.dir}` +
    (b ? `; device API: ${b.stored} kept, ${b.failed} failed, ${b.skipped} skipped.` : '.'));
  return b?.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
