const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'python', 'harness.py');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const skip = !hasRuntime('python3');

function runHarness({ fixture, handler, event = {}, env = {} }) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile('python3',
      [HARNESS, '--handler', handler, '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-test-1'],
      { cwd: path.join(FIXTURES, fixture),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
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

test('happy path returns envelope, context, and captures print logs', { skip }, async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'python/hello', handler: 'app.handler', event: { a: 1 } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.response.message, 'hello from python');
  assert.deepStrictEqual(envelope.response.echo, { a: 1 });
  assert.strictEqual(envelope.response.requestId, 'req-test-1');
  assert.strictEqual(envelope.response.remaining, true);
  assert.ok(envelope.durationMs >= 0);
  assert.ok(stdout.includes('hello log line'));
});

test('handler exception -> ok:false phase:invoke with stack trace', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python/error', handler: 'app.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'ValueError');
  assert.strictEqual(envelope.error.message, 'boom from python');
  assert.ok(envelope.error.stackTrace.length > 0);
});

test('missing module -> phase:init', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python/hello', handler: 'nope.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
});

test('malformed handler string -> phase:init', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python/hello', handler: 'nodots' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.MalformedHandlerName');
});
