// Reads the folder that mentra-glasses-tool writes. No Electron here, so it can be tested with plain Node.
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMAGE = new Set(Object.keys(TYPES));

// A run of `npm run frames` holds a screenshot per stream frame (thousands): the viewer lists the
// newest ones and the total, so it stays quick. Every screenshot stays in the folder.
const MAX_LISTED = 600;
// latest.jpg (the newest screenshot of a running `npm run frames`) written this recently = still live.
const LIVE_MS = 5000;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const list = (p) => { try { return fs.readdirSync(p).sort(); } catch { return []; } };
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text ? text.split('\n').filter(Boolean).length : 0;
  } catch { return 0; }
}

/** Folder names look like 2026-11-14T20-59-33-164Z_user. Turn the first part back into a time. */
function parseFolderName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.*)$/.exec(name);
  if (!m) return { time: null, label: name };
  return { time: Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`), label: m[6] };
}

/** Every screenshot session in the data folder, newest first. */
function scanLibrary(root) {
  root = path.resolve(root);
  const sessions = [];
  for (const name of list(root)) {
    const dir = path.join(root, name);
    if (!isDir(dir)) continue;
    const photosDir = path.join(dir, 'photos');
    const allPhotos = list(photosDir).filter((f) => IMAGE.has(path.extname(f).toLowerCase()));
    const photos = allPhotos.slice(-MAX_LISTED).map((f) => rel(root, path.join(photosDir, f)));
    const hasEvents = fs.existsSync(path.join(dir, 'events.jsonl'));
    if (!photos.length && !hasEvents && !fs.existsSync(path.join(dir, 'imu.jsonl'))) continue;
    const { time, label } = parseFolderName(name);
    const latest = path.join(dir, 'latest.jpg');
    const latestAt = mtime(latest);
    sessions.push({
      id: name, label, time: time ?? mtime(dir), photos, photoCount: allPhotos.length,
      events: countLines(path.join(dir, 'events.jsonl')),
      imu: countLines(path.join(dir, 'imu.jsonl')),
      latest: latestAt ? rel(root, latest) : null,
      live: latestAt > 0 && Date.now() - latestAt < LIVE_MS,
    });
  }

  sessions.sort((a, b) => b.time - a.time);
  return { root, sessions };
}

/** The events of one session. Lines that are not JSON are skipped, not fatal. */
function readEvents(root, sessionId, limit = 2000) {
  const file = resolveInside(root, `${sessionId}/events.jsonl`, { anyType: true });
  if (!file) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* half-written or broken line */ }
  }
  return out.slice(-limit);
}

/**
 * Turn a path from the page into a real file, but only one inside the data folder
 * (also after following symlinks) and only a picture.
 */
function resolveInside(root, relPath, { anyType = false } = {}) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) return null;
  let realRoot;
  try { realRoot = fs.realpathSync(path.resolve(root)); } catch { return null; }
  const full = path.resolve(realRoot, relPath);
  let real;
  try { real = fs.realpathSync(full); } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  const ext = path.extname(real).toLowerCase();
  if (!anyType && !IMAGE.has(ext)) return null;
  return real;
}

const contentType = (file) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

module.exports = { MAX_LISTED, scanLibrary, readEvents, resolveInside, contentType, parseFolderName };
