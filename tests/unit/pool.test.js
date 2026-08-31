const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../server/runtime/pool');

// A fake harness speaking the protocol, so the pool is exercised without any
// real language runtime.
const FAKE = path.join(os.tmpdir(), `awsplay-fake-harness-${process.pid}.mjs`);
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
let calls = 0;
let buf = Buffer.alloc(0); let need = null;
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (need === null) {
      const nl = buf.indexOf(0x0a); if (nl === -1) return;
      need = parseInt(buf.subarray(0, nl).toString(), 10); buf = buf.subarray(nl + 1);
    }
    if (buf.length < need) return;
    const req = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = null;
    calls++;
    console.log('log for ' + req.event.n);
    fs.writeFileSync(req.resultFile, JSON.stringify({
      ok: true, phase: 'invoke', response: { calls }, durationMs: 1,
      ...(calls === 1 ? { initMs: 5 } : {}),
    }));
    process.stdout.write('\\0AWSPLAY-END:' + req.requestId + '\\0');
  }
});
`);

function opts(over = {}) {
  return {
    id: 'fn1', runtime: 'node', dir: os.tmpdir(), handler: 'index.handler',
    env: { PATH: process.env.PATH }, memoryMb: 128, jarPath: null, autoTrace: false,
    command: { cmd: process.execPath, args: [FAKE] },
    watch: false,
    ...over,
  };
}

afterEach(async () => { await pool.shutdown(); });

test('a second invoke reuses the same process', async () => {
  const o = opts({ watch: true, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pool-')) });
  const a = await pool.acquire(o);
  const first = await a.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(first.envelope.response.calls, 1);
  assert.strictEqual(a.cold, true);

  const b = await pool.acquire(o);
  assert.strictEqual(b.cold, false);
  const second = await b.send({ event: { n: 2 }, timeoutMs: 5000 });
  assert.strictEqual(second.envelope.response.calls, 2, 'a fresh process was started');
  assert.strictEqual(pool.size(), 1);
});

test('each invoke gets only its own logs', async () => {
  const o = opts({ watch: true, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pool2-')) });
  const env = await pool.acquire(o);
  const first = await env.send({ event: { n: 1 }, timeoutMs: 5000 });
  const second = await env.send({ event: { n: 2 }, timeoutMs: 5000 });
  assert.match(first.logs, /log for 1/);
  assert.doesNotMatch(first.logs, /log for 2/);
  assert.match(second.logs, /log for 2/);
  assert.doesNotMatch(second.logs, /log for 1/);
});

test('a changed env value is a different environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pool3-'));
  await (await pool.acquire(opts({ watch: true, dir }))).send({ event: { n: 1 }, timeoutMs: 5000 });
  const changed = await pool.acquire(opts({ watch: true, dir, env: { PATH: process.env.PATH, A: '1' } }));
  assert.strictEqual(changed.cold, true, 'an env change reused the old environment');
  assert.strictEqual(pool.size(), 2);
});

test('timeoutMs is not part of the key — the parent enforces it', () => {
  assert.strictEqual(pool.keyFor(opts()), pool.keyFor(opts({ timeoutMs: 999 })));
});

test('handler, memory, jar, autoTrace and dir all change the key', () => {
  const base = pool.keyFor(opts());
  for (const over of [{ handler: 'other.handler' }, { memoryMb: 512 },
    { jarPath: '/x.jar' }, { autoTrace: true }, { dir: '/elsewhere' }]) {
    assert.notStrictEqual(pool.keyFor(opts(over)), base,
      `${JSON.stringify(over)} did not change the key`);
  }
});

test('evictForFunction drops every environment for that function', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pool4-'));
  await (await pool.acquire(opts({ watch: true, dir }))).send({ event: { n: 1 }, timeoutMs: 5000 });
  await (await pool.acquire(opts({ watch: true, dir, env: { PATH: process.env.PATH, A: '1' } })))
    .send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 2);
  pool.evictForFunction('fn1');
  assert.strictEqual(pool.size(), 0);
});

test('a timed-out invoke destroys the environment', async () => {
  const hang = path.join(os.tmpdir(), `awsplay-hang-${process.pid}.mjs`);
  fs.writeFileSync(hang, 'process.stdin.on("data", () => {});\n');
  const env = await pool.acquire(opts({ command: { cmd: process.execPath, args: [hang] } }));
  await assert.rejects(() => env.send({ event: {}, timeoutMs: 200 }), /timed out/i);
  assert.strictEqual(pool.size(), 0, 'a timed-out environment must not be reused');
});

test('a crashed child is evicted rather than handed out again', async () => {
  const crash = path.join(os.tmpdir(), `awsplay-crash-${process.pid}.mjs`);
  fs.writeFileSync(crash, 'process.stdin.on("data", () => process.exit(3));\n');
  const env = await pool.acquire(opts({ command: { cmd: process.execPath, args: [crash] } }));
  await assert.rejects(() => env.send({ event: {}, timeoutMs: 5000 }));
  assert.strictEqual(pool.size(), 0);
});

test('an environment whose directory cannot be watched is evicted after every invoke', async () => {
  const env = await pool.acquire(opts({ watch: false }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 0,
    'without a watch the only safe behaviour is always-cold');
});

test('editing a file in the project directory evicts the environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-watch-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = () => 1;\n');
  const env = await pool.acquire(opts({ dir, watch: true }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 1);

  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = () => 2;\n');
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(pool.size(), 0, 'a source edit did not evict the environment');
});

test('node_modules churn does not evict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-watch2-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const env = await pool.acquire(opts({ dir, watch: true }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });

  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'noise');
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(pool.size(), 1, 'a node_modules write should not cost a cold start');
});
