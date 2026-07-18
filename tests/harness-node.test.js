const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'node', 'harness.mjs');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function runHarness({ fixture, handler, event = {} }) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hn-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', handler, '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-test-2'],
      { cwd: path.join(FIXTURES, fixture),
        env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, stdout, stderr) => {
        let envelope = null;
        try {
          envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          fs.unlinkSync(resultFile);
        } catch {}
        resolve({ envelope, stdout, stderr });
      });
    child.stdin.end(JSON.stringify(event));
  });
}

test('async handler happy path with context and logs', async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'node-hello', handler: 'index.handler', event: { b: 2 } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.response.message, 'hello from node');
  assert.deepStrictEqual(envelope.response.echo, { b: 2 });
  assert.strictEqual(envelope.response.requestId, 'req-test-2');
  assert.strictEqual(envelope.response.remaining, true);
  assert.ok(stdout.includes('node log line'));
});

test('callback-style handler resolves via callback', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.callbackHandler' });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.message, 'hello from callback');
});

test('thrown error -> ok:false phase:invoke', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.errorHandler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'TypeError');
  assert.strictEqual(envelope.error.message, 'boom from node');
});

test('missing file -> phase:init Runtime.ImportModuleError', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'missing.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.ImportModuleError');
});

test('missing export -> phase:init Runtime.HandlerNotFound', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.nope' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.HandlerNotFound');
});

test('malformed handler string -> phase:init Runtime.MalformedHandlerName', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'nodots' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.MalformedHandlerName');
});
