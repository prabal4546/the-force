// As many pictures per second as the glasses can give: cut them out of the glasses' live video.
//   npm run frames
// Then point the glasses' live stream at the printed RTMP address (Mentra's example app: Stream screen;
// or the SDK route with VIDEO=1). Every frame (or FRAMES_PER_SEC of them) becomes a JPEG in
// data/<time>_stream/photos/ and, when BODYOS_API_URL is set, a photo in the BodyOS API as it is cut.
// The stream itself is kept as recording.mp4 in the same folder and sent to the API when it stops.
//
// Why not photos? Each photo command takes seconds over Bluetooth; video frames come 15-30 per second.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { forwardToBodyos } from './bodyos.mjs';
import { lanAddress, loadDotEnv, readConfig } from './config.mjs';
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

/** The ffmpeg arguments: one input, the recording (optional) and a JPEG pipe. */
export function ffmpegArgs({ input, recordingFile = null, framesPerSec = 0, quality = 4 }) {
  const args = ['-hide_banner', '-loglevel', 'error', ...input];
  if (recordingFile) {
    args.push('-map', '0:v', '-map', '0:a?', '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', recordingFile);
  }
  args.push('-map', '0:v');
  if (framesPerSec > 0) args.push('-vf', `fps=${framesPerSec}`);
  else args.push('-fps_mode', 'passthrough'); // every frame the glasses send, once
  args.push('-c:v', 'mjpeg', '-q:v', String(quality), '-f', 'image2pipe', 'pipe:1');
  return args;
}

/**
 * Start cutting frames. Returns { store, stats, done, stop() }.
 * `input` is ffmpeg's input arguments (the RTMP listener by default; tests use a generated video).
 */
export function startFrames({
  dataDir,
  input,
  record = true,
  framesPerSec = 0,
  quality = 4,
  bodyos = null,
  log = console,
  ffmpeg = 'ffmpeg',
}) {
  const store = new SessionStore(dataDir, 'stream');
  const forwarder = bodyos?.url ? forwardToBodyos(store, { ...bodyos, log }) : null;
  const recordingFile = record ? path.join(store.dir, 'recording.mp4') : null;
  const stats = { frames: 0, bytes: 0, startedAt: null };
  const writes = new Set();

  store.event('frames_start', { framesPerSec: framesPerSec || 'all', quality });
  const child = spawn(ffmpeg, ffmpegArgs({ input, recordingFile, framesPerSec, quality }), { stdio: ['ignore', 'pipe', 'pipe'] });

  const splitter = new JpegSplitter((frame) => {
    stats.frames += 1;
    stats.bytes += frame.length;
    stats.startedAt ??= Date.now();
    const n = stats.frames;
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

  // When ffmpeg is gone: save the last frames, keep the recording, finish uploading, close the folder.
  const done = (async () => {
    const result = await exited;
    await new Promise((resolve) => (splitter.writableFinished ? resolve() : splitter.once('finish', resolve)));
    await Promise.all([...writes]);
    if (recordingFile && fs.existsSync(recordingFile) && fs.statSync(recordingFile).size > 0) {
      const rel = path.relative(path.dirname(store.dir), recordingFile).split(path.sep).join('/');
      // This run's folder name makes the API requestId unique to this recording.
      store.event('video', { file: rel, bytes: fs.statSync(recordingFile).size, requestId: path.basename(store.dir) });
    }
    if (forwarder) {
      const left = forwarder.stats.pending;
      if (left) log.log(`Sending the last ${left} pictures to the BodyOS API...`);
      await forwarder.drain();
    }
    store.event('frames_end', { frames: stats.frames, ffmpeg: result });
    await store.close();
    return { ffmpeg: result, frames: stats.frames, bodyos: forwarder?.stats ?? null };
  })();

  return {
    store,
    stats,
    bodyos: forwarder,
    done,
    /**
     * Stop listening or recording; ffmpeg finishes the recording file first.
     * A Ctrl+C in the terminal already reached ffmpeg, and a second SIGINT would make it quit without
     * closing its files: so wait a moment, then ask, then insist.
     */
    stop({ graceMs = 1500 } = {}) {
      const running = () => child.exitCode === null && child.signalCode === null;
      const later = (ms, fn) => setTimeout(() => running() && fn(), ms).unref();
      later(graceMs, () => child.kill('SIGINT'));
      later(graceMs + 10_000, () => child.kill('SIGKILL'));
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
  const run = startFrames({
    log,
    dataDir: cfg.dataDir,
    input: ['-listen', '1', '-i', `rtmp://0.0.0.0:${port}/live/glasses`],
    framesPerSec: cfg.framesPerSec,
    quality: cfg.frameQuality,
    bodyos: cfg.bodyos,
  });
  console.log('');
  console.log('Cutting pictures out of the glasses\' live video.');
  console.log(`  Live video (RTMP): ${rtmpUrl}   paste this into Mentra's Stream screen (or RTMP_URL with VIDEO=1)`);
  console.log(`  Pictures:          ${cfg.framesPerSec ? `${cfg.framesPerSec} per second` : 'every frame the glasses send'} -> ${run.store.photosDir}`);
  console.log(cfg.bodyos.url
    ? `  Also keeping in:   BodyOS API ${cfg.bodyos.url} (device ${cfg.bodyos.deviceId}), ${cfg.bodyos.parallel} uploads at a time`
    : '  BodyOS API:        off (set BODYOS_API_URL to send every picture there)');
  console.log('Waiting for the stream. Ctrl+C to stop.');

  let last = { frames: 0, stored: 0, time: Date.now() };
  const ticker = setInterval(() => {
    const now = Date.now();
    const b = run.bodyos?.stats;
    const rate = ((run.stats.frames - last.frames) * 1000) / (now - last.time);
    const sent = b ? ((b.stored - last.stored) * 1000) / (now - last.time) : 0;
    if (run.stats.frames === 0) return;
    process.stdout.write(
      `\r${run.stats.frames} pictures (${rate.toFixed(1)}/s)` +
        (b ? `  API: ${b.stored} kept (${sent.toFixed(1)}/s), ${b.pending} waiting, ${b.failed} failed` : '') +
        '      ',
    );
    midLine = true;
    last = { frames: run.stats.frames, stored: b?.stored ?? 0, time: now };
  }, 1000);

  process.once('SIGINT', () => {
    log.log('Stopping...');
    void run.stop();
  });
  process.once('SIGTERM', () => void run.stop({ graceMs: 0 }));
  const result = await run.done;
  clearInterval(ticker);
  const b = result.bodyos;
  log.log(`Stopped. ${result.frames} pictures in ${run.store.dir}` +
    (b ? `; BodyOS API: ${b.stored} kept, ${b.failed} failed, ${b.skipped} skipped.` : '.'));
  return b?.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
