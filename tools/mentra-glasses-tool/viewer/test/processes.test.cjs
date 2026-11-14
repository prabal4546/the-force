const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProcessManager } = require('../electron/processes.cjs');

/** A pretend tool folder: each script says who it is (and LIVE_PORT), then waits to be stopped. */
function fakeTool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  const waitForStop = "process.on('SIGINT', () => { console.log('got stop'); process.exit(0); }); setInterval(() => {}, 1000);";
  for (const name of ['receiver', 'frames', 'demo']) {
    fs.writeFileSync(path.join(dir, 'src', `${name}.mjs`), `console.log('${name} LIVE_PORT=' + (process.env.LIVE_PORT ?? '-')); ${waitForStop}`);
  }
  fs.writeFileSync(path.join(dir, 'scripts', 'record-video.sh'), "trap 'echo got stop; exit 0' INT; echo record-video; while true; do sleep 0.1; done\n");
  return dir;
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test('with live video and every frame: the receiver plus npm run frames, without a second live feed', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  assert.equal(pm.start({ mode: 'receiver', video: true, frames: true }).ok, true);
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l === 'frames: frames LIVE_PORT=0')), lines().join('\n'));
  assert.ok(await until(() => lines().some((l) => l.startsWith('receiver: receiver'))));
  assert.ok(!lines().some((l) => l.includes('record-video')));
  assert.equal(pm.snapshot().status.video.frames, true);
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});

test('with live video only: the receiver plus npm run video, as before', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  pm.start({ mode: 'receiver', video: true, frames: false });
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l === 'video: record-video')), lines().join('\n'));
  assert.equal(pm.snapshot().status.video.frames, false);
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});

test('the demo never starts live video, even when asked for frames', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  pm.start({ mode: 'demo', video: true, frames: true });
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l.startsWith('demo: demo'))));
  assert.ok(!lines().some((l) => l.startsWith('frames:') || l.startsWith('video:')));
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});
