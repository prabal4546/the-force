// Keep every glasses photo in the team's BodyOS API as well as in data/.
// Contract: docs/api.md on the API branch ("Send a glasses photo"):
//   POST /v1/devices/connect                  register this tool's glasses as device_type "glasses"
//   POST /v1/glasses/photos?device_id=<id>    multipart: requestId + photo (JPEG or PNG) -> 201 { artifact_id, photoUrl }
// The local copy in data/ is always written first; the API copy is extra. A failed upload is
// retried, then written to events.jsonl as "bodyos_failed" so nothing disappears silently.
import fs from 'node:fs';
import path from 'node:path';

const API_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
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

/**
 * The requestId the API sees: the glasses' own id plus our file name, so each saved photo has its own
 * id. Retrying the same file sends the same id and bytes, and the API answers with the same artifact.
 */
export function apiRequestId(originalId, fileName) {
  const stem = cleanId(path.basename(fileName, path.extname(fileName)));
  const base = cleanId(originalId).slice(0, 128 - stem.length - 1);
  return (base ? `${base}-${stem}` : stem).slice(0, 128);
}

class ApiError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}

/**
 * Watch `store` and send each new photo to the API, one at a time, in order.
 * Returns { ready, drain(), stats }. Call `await drain()` before closing the store.
 */
export function forwardToBodyos(store, { url, token = '', deviceId = 'mentra-live', log = console, fetchImpl = fetch, attempts = 3, retryDelayMs = 1000 } = {}) {
  const stats = { stored: 0, failed: 0, skipped: 0 };
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let queue = Promise.resolve();
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
    if (!res.ok) {
      const detail = typeof body?.detail === 'string' ? body.detail : text.slice(0, 200);
      throw new ApiError(res.status, detail);
    }
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

  async function upload(record) {
    const file = path.join(store.dir, record.file);
    const type = API_TYPES[path.extname(file).toLowerCase()];
    if (!type) {
      stats.skipped += 1;
      store.event('bodyos_skipped', { file: record.file, reason: 'the API takes JPEG and PNG only' });
      return;
    }
    const bytes = await fs.promises.readFile(file);
    const requestId = apiRequestId(record.requestId, record.file);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (!registered) await register();
        const form = new FormData();
        form.set('requestId', requestId);
        form.set('photo', new Blob([bytes], { type }), path.basename(file));
        const body = await call(`/v1/glasses/photos?device_id=${encodeURIComponent(deviceId)}`, { method: 'POST', body: form });
        stats.stored += 1;
        store.event('bodyos_stored', { file: record.file, requestId, artifactId: body?.artifact_id ?? null, photoUrl: body?.photoUrl ?? null });
        return;
      } catch (err) {
        lastError = err;
        // The API keeps registrations in memory: after it restarts, register again and retry.
        if (err.status === 404) registered = false;
        // Wrong token, bad photo, or the same requestId with other bytes: retrying cannot help.
        if ([401, 409, 413, 415, 422].includes(err.status)) break;
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
      }
    }
    stats.failed += 1;
    const message = String(lastError?.message ?? lastError);
    store.event('bodyos_failed', { file: record.file, requestId, status: lastError?.status ?? null, error: message });
    log.warn(`BodyOS API did not keep ${record.file} (${message}). The copy in data/ is safe.`);
  }

  const unsubscribe = store.subscribe((record) => {
    if (record.type !== 'photo' || !record.file) return;
    queue = queue.then(() => upload(record)).catch((err) => log.warn(`BodyOS forwarder: ${err.message}`));
  });

  // Register at start so a wrong address or token shows up before the first photo.
  const ready = register().then(
    () => true,
    (err) => {
      log.warn(`BodyOS API at ${url} is not reachable yet (${err.message}). Photos are still saved in data/ and each one will be tried again.`);
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
