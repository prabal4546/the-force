import os from 'node:os';
import { readBodyosConfig } from './bodyos.mjs';

/** Load .env from the folder the program is started in (environment variables win). */
export function loadDotEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env file: fine, plain environment variables still work */
  }
}

/** First non-internal IPv4 address of this computer, for the glasses to reach it on Wi-Fi. */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
  }
  return value;
};

const num = (value, name, { min = 0 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min} (got "${value}")`);
  return n;
};

/** Turn environment variables into a checked settings object. */
export function readConfig(env = process.env) {
  // STREAM=1: the SDK route asks the glasses to stream live video to this Mac, where `npm run frames`
  // turns every frame into a screenshot. Nothing of the stream itself is kept.
  const stream = env.STREAM === '1';
  const rtmpPort = 1935;
  return {
    packageName: env.PACKAGE_NAME ?? '',
    apiKey: env.MENTRAOS_API_KEY ?? '',
    port: num(env.PORT ?? 3000, 'PORT', { min: 1 }),
    dataDir: env.DATA_DIR ?? './data',
    // One camera, one job: while the glasses stream, photo commands are off unless asked for explicitly.
    photoIntervalSec: num(env.PHOTO_INTERVAL_SEC ?? (stream ? 0 : 10), 'PHOTO_INTERVAL_SEC'),
    photoSize: oneOf(env.PHOTO_SIZE ?? 'medium', ['small', 'medium', 'large', 'full'], 'PHOTO_SIZE'),
    photoCompress: oneOf(env.PHOTO_COMPRESS ?? 'medium', ['none', 'medium', 'heavy'], 'PHOTO_COMPRESS'),
    stream,
    rtmpUrl: env.RTMP_URL || `rtmp://${lanAddress()}:${rtmpPort}/live/glasses`,
    streamConfig: {
      width: num(env.STREAM_WIDTH ?? 1280, 'STREAM_WIDTH', { min: 1 }),
      height: num(env.STREAM_HEIGHT ?? 720, 'STREAM_HEIGHT', { min: 1 }),
      // Frames per second = screenshots per second with FRAMES_PER_SEC=0.
      frameRate: num(env.STREAM_FPS ?? 30, 'STREAM_FPS', { min: 1 }),
      bitrate: num(env.STREAM_BITRATE ?? 2_000_000, 'STREAM_BITRATE', { min: 1 }),
    },
    ingestToken: env.INGEST_TOKEN ?? '',
    // Live feed for the Glasses Viewer app, on this computer only. 0 switches it off.
    livePort: num(env.LIVE_PORT ?? 3001, 'LIVE_PORT'),
    // npm run frames: screenshots cut from the live stream. 0 = every frame the glasses send.
    framesPerSec: num(env.FRAMES_PER_SEC ?? 0, 'FRAMES_PER_SEC'),
    // JPEG quality for those screenshots: 2 (best, biggest) to 31 (smallest).
    frameQuality: (() => {
      const q = num(env.FRAME_QUALITY ?? 4, 'FRAME_QUALITY', { min: 2 });
      if (q > 31 || !Number.isInteger(q)) throw new Error(`FRAME_QUALITY must be a whole number from 2 to 31 (got "${env.FRAME_QUALITY}")`);
      return q;
    })(),
    // The team's device API (branch codex/api): every screenshot is sent there. Empty URL = off.
    bodyos: readBodyosConfig(env),
  };
}
