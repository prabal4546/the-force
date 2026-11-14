// Keep every glasses photo and video in the team's BodyOS API as well as in data/.
// Contract: docs/api.md on the API branch:
//   POST /v1/devices/connect                  register this tool's glasses as device_type "glasses"
//   POST /v1/glasses/photos?device_id=<id>    multipart: requestId + photo (JPEG or PNG) -> 201 { artifact_id, photoUrl }
//   POST /v1/glasses/videos?device_id=<id>    multipart: requestId + video (MP4 or MOV)  -> 201 { artifact_id, videoUrl }
// The local copy in data/ is always written first; the API copy is extra. A failed upload is
// retried, then written to events.jsonl as "bodyos_failed" so nothing disappears silently.
//
// Send files by hand (for example a recording from `npm run video`):
//   npm run send -- data/video/<time>/recording.mp4 [more files...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KINDS = {
  photo: { route: '/v1/glasses/photos', field: 'photo', url: 'photoUrl', types: { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' } },
  video: { route: '/v1/glasses/videos', field: 'video', url: 'videoUrl', types: { '.mp4': 'video/mp4', '.mov': 'video/quicktime' } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');

/** BODYOS_API_URL empty = switched off. */
export function readBodyosConfig(env = process.env) {
  const url = String(env.BODYOS_API_URL ?? '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) throw new Error(`BODYOS_API_URL must start with http:// or https:// (got "${url}")`);
  const deviceId = String(env.BODYOS_DEVICE_ID ?? 'mentra-live');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('BODYOS_DEVICE_ID: letters, numbers, _ and - only, up to 128');
  return { url, token: String(env.BODYOS_SESSION_TOKEN ?? ''), deviceId };
}

/** "photo", "video", or null when the API takes neither (judged by the file's extension). */
export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(KINDS).find((kind) => KINDS[kind].types[ext]) ?? null;
}

/**
 * The requestId the API sees: the glasses' own id plus our file name, so each saved file has its own
 * id. Retrying the same file sends the same id and bytes, and the API answers with the same artifact.
 */
export function apiRequestId(originalId, fileName) {
  const stem = cleanId(path.basename(fileName, path.extname(fileName))) || 'file';
  const base = cleanId(originalId).slice(0, 128 - stem.length - 1);
  return (base ? `${base}-${stem}` : stem).slice(0, 128);
}

class ApiError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}

// Retrying cannot help these: wrong token, rejected or too-large file, same requestId with other bytes.
const FINAL = [401, 409, 413, 415, 422];

/** A client for one glasses device in the API. */
export function bodyosClient({ url, token = '', deviceId = 'mentra-live', fetchImpl = fetch, attempts = 3, retryDelayMs = 1000 }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let registered = false;

  async function call(pathname, init) {
    const res = await fetchImpl(`${url}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new ApiError(res.status, typeof body?.detail === 'string' ? body.detail : text.slice(0, 200));
    return body;
  }

  async function register() {
    await call('/v1/devices/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, device_type: 'glasses', hardware_status: 'connected' }),
    });
    registered = true;
  }

  /** Send one file. Returns { kind, requestId, artifactId, url }. Throws the last error after retries. */
  async function send(file, originalRequestId) {
    const kind = kindOf(file);
    if (!kind) throw Object.assign(new Error('the API takes JPEG/PNG photos and MP4/MOV videos only'), { skipped: true });
    const spec = KINDS[kind];
    const type = spec.types[path.extname(file).toLowerCase()];
    const requestId = apiRequestId(originalRequestId, file);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (!registered) await register();
        const form = new FormData();
        form.set('requestId', requestId);
        // Read from disk as it is sent: a video can be hundreds of MB.
        form.set(spec.field, await fs.openAsBlob(file, { type }), path.basename(file));
        const body = await call(`${spec.route}?device_id=${encodeURIComponent(deviceId)}`, { method: 'POST', body: form });
        return { kind, requestId, artifactId: body?.artifact_id ?? null, url: body?.[spec.url] ?? null };
      } catch (err) {
        lastError = err;
        if (err.status === 404) registered = false; // the API restarted: its registrations are in memory
        if (FINAL.includes(err.status)) break;
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
      }
    }
    throw Object.assign(lastError ?? new Error('upload failed'), { requestId });
  }

  return { register, send };
}

/**
 * Watch `store` and send each new photo and video to the API, one at a time, in order.
 * Returns { ready, drain(), stats }. Call `await drain()` before closing the store.
 */
export function forwardToBodyos(store, { log = console, ...settings } = {}) {
  const client = bodyosClient(settings);
  const stats = { stored: 0, failed: 0, skipped: 0 };
  const dataDir = path.dirname(store.dir); // video events name files relative to data/
  let queue = Promise.resolve();

  async function forward(record) {
    const file = record.type === 'video' ? path.join(dataDir, record.file) : path.join(store.dir, record.file);
    try {
      const result = await client.send(file, record.requestId);
      stats.stored += 1;
      store.event('bodyos_stored', { kind: result.kind, file: record.file, requestId: result.requestId, artifactId: result.artifactId, url: result.url });
    } catch (err) {
      if (err.skipped) {
        stats.skipped += 1;
        store.event('bodyos_skipped', { file: record.file, reason: err.message });
        return;
      }
      stats.failed += 1;
      store.event('bodyos_failed', { file: record.file, requestId: err.requestId ?? null, status: err.status ?? null, error: String(err.message ?? err) });
      log.warn(`BodyOS API did not keep ${record.file} (${err.message}). The copy in data/ is safe.`);
    }
  }

  const unsubscribe = store.subscribe((record) => {
    if ((record.type !== 'photo' && record.type !== 'video') || !record.file) return;
    queue = queue.then(() => forward(record)).catch((err) => log.warn(`BodyOS forwarder: ${err.message}`));
  });

  // Register at start so a wrong address or token shows up before the first photo.
  const ready = client.register().then(
    () => true,
    (err) => {
      log.warn(`BodyOS API at ${settings.url} is not reachable yet (${err.message}). Files are still saved in data/ and each one will be tried again.`);
      return false;
    },
  );

  return {
    ready,
    stats,
    async drain() {
      await ready;
      let seen;
      do {
        seen = queue;
        await seen;
      } while (seen !== queue);
      unsubscribe();
    },
  };
}

/** `npm run send -- <files>`: send files already on disk. Exit code 1 if any was not kept. */
async function main(args) {
  const ifConfigured = args[0] === '--if-configured'; // used by scripts/record-video.sh
  const files = ifConfigured ? args.slice(1) : args;
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env: environment variables still work */
  }
  const cfg = readBodyosConfig();
  if (!cfg.url) {
    if (ifConfigured) return 0;
    console.error('Set BODYOS_API_URL (and BODYOS_SESSION_TOKEN if the API has one) to send files.');
    return 1;
  }
  if (!files.length) {
    console.error('Usage: npm run send -- <photo or video file> [more files...]');
    return 1;
  }
  const client = bodyosClient(cfg);
  let failed = 0;
  for (const file of files) {
    try {
      const r = await client.send(file);
      console.log(`kept ${file} -> ${r.url} (${r.kind}, artifact ${r.artifactId})`);
    } catch (err) {
      failed += 1;
      console.error(`NOT kept ${file}: ${err.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
