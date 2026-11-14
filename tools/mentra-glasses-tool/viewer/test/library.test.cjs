const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLibrary, readEvents, resolveInside, parseFolderName } = require('../electron/library.cjs');

function makeData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-'));
  const s = path.join(root, '2026-11-14T20-59-33-164Z_user1');
  fs.mkdirSync(path.join(s, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(s, 'photos', 'photo_000002_2.jpg'), 'b');
  fs.writeFileSync(path.join(s, 'photos', 'photo_000001_1.jpg'), 'a');
  fs.writeFileSync(path.join(s, 'photos', 'notes.txt'), 'not a photo');
  fs.writeFileSync(path.join(s, 'events.jsonl'), '{"time":1,"type":"session_start"}\nnot json\n{"time":2,"type":"photo"}\n');
  fs.mkdirSync(path.join(root, 'empty-folder'));
  return root;
}

test('finds screenshot sessions, skips empty folders and non-pictures', () => {
  const root = makeData();
  const lib = scanLibrary(root);
  assert.equal(lib.sessions.length, 1);
  const s = lib.sessions[0];
  assert.equal(s.label, 'user1');
  assert.equal(s.time, Date.parse('2026-11-14T20:59:33.164Z'));
  assert.deepEqual(s.photos, ['2026-11-14T20-59-33-164Z_user1/photos/photo_000001_1.jpg', '2026-11-14T20-59-33-164Z_user1/photos/photo_000002_2.jpg']);
  assert.equal(s.events, 3);
  assert.equal(s.latest, null);
  assert.equal(s.live, false);
  assert.deepEqual(Object.keys(lib).sort(), ['root', 'sessions']);
});

test('a missing data folder is empty, not an error', () => {
  const lib = scanLibrary(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()));
  assert.deepEqual(lib.sessions, []);
});

test('events: broken lines are skipped', () => {
  const root = makeData();
  const ev = readEvents(root, '2026-11-14T20-59-33-164Z_user1');
  assert.deepEqual(ev.map((e) => e.type), ['session_start', 'photo']);
  assert.deepEqual(readEvents(root, '../../etc'), []);
});

test('only pictures inside the data folder can be served', () => {
  const root = makeData();
  assert.ok(resolveInside(root, '2026-11-14T20-59-33-164Z_user1/photos/photo_000001_1.jpg'));
  assert.equal(resolveInside(root, '../../../etc/passwd'), null);
  assert.equal(resolveInside(root, '/etc/passwd'), null);
  assert.equal(resolveInside(root, '2026-11-14T20-59-33-164Z_user1/photos/notes.txt'), null);
  assert.equal(resolveInside(root, '2026-11-14T20-59-33-164Z_user1/events.jsonl'), null);
  assert.equal(resolveInside(root, 'nope.jpg'), null);
  assert.equal(resolveInside(root, 'a\0.jpg'), null);
  fs.writeFileSync(path.join(root, 'clip.mp4'), 'x');
  assert.equal(resolveInside(root, 'clip.mp4'), null);
  // a symlink that points out of the folder
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.jpg`);
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(root, 'link.jpg'));
  assert.equal(resolveInside(root, 'link.jpg'), null);
});

test('folder names that are not timestamps keep their name', () => {
  assert.deepEqual(parseFolderName('imu-only'), { time: null, label: 'imu-only' });
});

test('a big run of npm run frames lists its newest 600 screenshots and the total, and is live while latest.jpg is fresh', () => {
  const { MAX_LISTED } = require('../electron/library.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-frames-'));
  const name = '2026-11-14T22-55-19-501Z_stream';
  fs.mkdirSync(path.join(root, name, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'events.jsonl'), '{"type":"frames_start"}\n');
  for (let i = 1; i <= 650; i += 1) fs.writeFileSync(path.join(root, name, 'photos', `photo_${String(i).padStart(6, '0')}_1.jpg`), 'x');
  fs.writeFileSync(path.join(root, name, 'latest.jpg'), 'jpg');
  const lib = scanLibrary(root);
  const s = lib.sessions.find((x) => x.id === name);
  assert.equal(MAX_LISTED, 600);
  assert.equal(s.photoCount, 650);
  assert.equal(s.photos.length, 600);
  assert.equal(s.photos[0], `${name}/photos/photo_000051_1.jpg`);
  assert.equal(s.photos.at(-1), `${name}/photos/photo_000650_1.jpg`);
  assert.equal(s.latest, `${name}/latest.jpg`);
  assert.equal(s.live, true);
  assert.ok(resolveInside(root, s.latest));
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(path.join(root, name, 'latest.jpg'), old, old); // the run stopped a minute ago
  assert.equal(scanLibrary(root).sessions.find((x) => x.id === name).live, false);
});
