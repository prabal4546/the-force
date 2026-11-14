// Send every glasses screenshot to the team's device API (branch codex/api, docs/api.md there):
//   POST /v1/devices/connect                  register this tool's glasses as device_type "glasses"
//   POST /v1/glasses/photos?device_id=<id>    multipart: requestId + photo (JPEG or PNG) -> 201 { artifact_id, photoUrl }
// The copy in data/ is always written first. A failed upload is retried, then written to
// events.jsonl as "bodyos_failed" so nothing disappears silently.
//
// Send screenshots already on disk:
//   npm run send -- data/<time>_stream/photos/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// What POST /v1/glasses/photos takes (it checks the bytes too).
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');

/** BODYOS_API_URL empty = switched off. */
export function readBodyosConfig(env = process.env) {
  const url = String(env.BODYOS_API_URL ?? '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) throw new Error(`BODYOS_API_URL must start with http:// or https:// (got "${url}")`);
  // glasses-1 is the id docs/api.md and docs/sdk-compatibility.md use for the glasses.
  const deviceId = String(env.BODYOS_DEVICE_ID ?? 'glasses-1');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('BODYOS_DEVICE_ID: letters, numbers, _ and - only, up to 128');
  const parallel = Number(env.BODYOS_PARALLEL ?? 4);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) throw new Error(`BODYOS_PARALLEL must be a whole number from 1 to 32 (got "${env.BODYOS_PARALLEL}")`);
  return { url, token: String(env.BODYOS_SESSION_TOKEN ?? ''), deviceId, parallel };
}

/** The photo's content type, or null when the API does not take this file (judged by its extension). */
export function photoType(file) {
  return PHOTO_TYPES[path.extname(file).toLowerCase()] ?? null;
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
export function bodyosClient({ url, token = '', deviceId = 'glasses-1', fetchImpl = fetch, attempts = 3, retryDelayMs = 1000 }) {
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

  /** Send one photo. Returns { requestId, artifactId, url }. Throws the last error after retries. */
  async function send(file, originalRequestId) {
    const type = photoType(file);
    if (!type) throw Object.assign(new Error('the API takes JPEG and PNG photos only'), { skipped: true });
    const requestId = apiRequestId(originalRequestId, file);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (!registered) await register();
        const form = new FormData();
        form.set('requestId', requestId);
        form.set('photo', await fs.openAsBlob(file, { type }), path.basename(file));
        const body = await call(`/v1/glasses/photos?device_id=${encodeURIComponent(deviceId)}`, { method: 'POST', body: form });
        return { requestId, artifactId: body?.artifact_id ?? null, url: body?.photoUrl ?? null };
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
 * Watch `store` and send each new photo to the API, `parallel` at a time (in the order
 * they were saved; with more than 1 they may finish out of order).
 * Returns { ready, drain(), stats }. `stats.pending` counts files not sent yet.
 * Call `await drain()` before closing the store.
 */
export function forwardToBodyos(store, { log = console, parallel = 4, ...settings } = {}) {
  const client = bodyosClient(settings);
  const stats = { stored: 0, failed: 0, skipped: 0, pending: 0 };
  const waiting = [];
  let active = 0;
  let idle = null; // resolves when nothing is waiting or being sent
  let resolveIdle = null;

  function pump() {
    while (active < parallel && waiting.length) {
      const record = waiting.shift();
      active += 1;
      forward(record)
        .catch((err) => log.warn(`device API forwarder: ${err.message}`))
        .finally(() => {
          active -= 1;
          stats.pending -= 1;
          pump();
        });
    }
    if (active === 0 && waiting.length === 0 && resolveIdle) {
      resolveIdle();
      idle = resolveIdle = null;
    }
  }

  async function forward(record) {
    try {
      const result = await client.send(path.join(store.dir, record.file), record.requestId);
      stats.stored += 1;
      store.event('bodyos_stored', { file: record.file, requestId: result.requestId, artifactId: result.artifactId, url: result.url });
    } catch (err) {
      if (err.skipped) {
        stats.skipped += 1;
        store.event('bodyos_skipped', { file: record.file, reason: err.message });
        return;
      }
      stats.failed += 1;
      store.event('bodyos_failed', { file: record.file, requestId: err.requestId ?? null, status: err.status ?? null, error: String(err.message ?? err) });
      log.warn(`The device API did not keep ${record.file} (${err.message}). The copy in data/ is safe.`);
    }
  }

  const unsubscribe = store.subscribe((record) => {
    if (record.type !== 'photo' || !record.file) return;
    waiting.push(record);
    stats.pending += 1;
    pump();
  });

  // Register at start so a wrong address or token shows up before the first photo.
  const ready = client.register().then(
    () => true,
    (err) => {
      log.warn(`The device API at ${settings.url} is not reachable yet (${err.message}). Screenshots are still saved in data/ and each one will be tried again.`);
      return false;
    },
  );

  return {
    ready,
    stats,
    async drain() {
      await ready;
      while (active > 0 || waiting.length > 0) {
        idle ??= new Promise((resolve) => (resolveIdle = resolve));
        await idle;
      }
      unsubscribe();
    },
  };
}

/** `npm run send -- <files>`: send screenshots already on disk. Exit code 1 if any was not kept. */
async function main(files) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env: environment variables still work */
  }
  const cfg = readBodyosConfig();
  if (!cfg.url) {
    console.error('Set BODYOS_API_URL (and BODYOS_SESSION_TOKEN if the API has one) to send screenshots.');
    return 1;
  }
  if (!files.length) {
    console.error('Usage: npm run send -- <JPEG or PNG file> [more files...]');
    return 1;
  }
  const client = bodyosClient(cfg);
  let failed = 0;
  for (const file of files) {
    try {
      // The folder name keeps same-named files from different runs apart.
      const r = await client.send(file, path.basename(path.dirname(path.resolve(file))));
      console.log(`kept ${file} -> ${r.url} (artifact ${r.artifactId})`);
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
