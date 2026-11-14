const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProcessManager } = require('../electron/processes.cjs');

/** A pretend tool folder: each script says who it is (and LIVE_PORT, STREAM), then waits to be stopped. */
function fakeTool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules', '@mentra', 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '');
  const waitForStop = "process.on('SIGINT', () => { console.log('got stop'); process.exit(0); }); setInterval(() => {}, 1000);";
  for (const [name, file] of [['receiver', 'receiver'], ['frames', 'frames'], ['demo', 'demo'], ['glasses', 'server']]) {
    fs.writeFileSync(path.join(dir, 'src', `${file}.mjs`),
      `console.log('${name} LIVE_PORT=' + (process.env.LIVE_PORT ?? '-') + ' STREAM=' + (process.env.STREAM ?? '-')); ${waitForStop}`);
  }
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

test('fast screenshots: the receiver plus npm run frames, without a second live feed', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  assert.equal(pm.start({ mode: 'receiver', fast: true }).ok, true);
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l.startsWith('frames: frames LIVE_PORT=0'))), lines().join('\n'));
  assert.ok(await until(() => lines().some((l) => l.startsWith('receiver: receiver'))));
  assert.equal(pm.snapshot().status.frames.running, true);
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});

test('fast screenshots on the cloud route: the glasses are asked to stream (STREAM=1)', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  assert.equal(pm.start({ mode: 'glasses', fast: true }).ok, true);
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l === 'glasses: glasses LIVE_PORT=- STREAM=1')), lines().join('\n'));
  assert.ok(await until(() => lines().some((l) => l.startsWith('frames: frames LIVE_PORT=0'))));
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});

test('without fast screenshots: the recorder only, no stream', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  pm.start({ mode: 'glasses', fast: false });
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l === 'glasses: glasses LIVE_PORT=- STREAM=0')), lines().join('\n'));
  assert.ok(!lines().some((l) => l.startsWith('frames:')));
  assert.equal(pm.snapshot().status.frames.running, false);
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});

test('the demo never starts the stream, even when asked for fast screenshots', async () => {
  const pm = createProcessManager({ toolDir: fakeTool(), node: process.execPath });
  pm.start({ mode: 'demo', fast: true });
  const lines = () => pm.snapshot().log.map((e) => `${e.source}: ${e.line}`);
  assert.ok(await until(() => lines().some((l) => l.startsWith('demo: demo'))));
  assert.ok(!lines().some((l) => l.startsWith('frames:')));
  pm.stop();
  assert.ok(await until(() => !pm.running()));
});
