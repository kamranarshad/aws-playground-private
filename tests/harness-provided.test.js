const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'provided', 'harness.mjs');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noBash = !hasRuntime('bash', ['--version']);

function runHarness({ dir, handler, event = {} }) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', handler, '--result-file', resultFile,
       '--timeout-ms', '15000', '--memory-mb', '128', '--request-id', 'req-prov-1'],
      { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME,
        AWS_LAMBDA_FUNCTION_NAME: 'prov-test', AWS_REGION: 'us-east-1' } },
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

function scriptProject(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-prov-'));
  const file = path.join(dir, 'bootstrap');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return dir;
}

test('bash fixture round-trips the event via the runtime API', { skip: noBash }, async () => {
  const { envelope } = await runHarness({
    dir: path.join(FIXTURES, 'provided/bash'), handler: 'bootstrap',
    event: { hello: 'os' } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.deepStrictEqual(envelope.response.echo, { hello: 'os' });
  assert.strictEqual(envelope.response.runtime, 'bash');
  assert.ok(envelope.durationMs >= 0);
});

test('bootstrap posting to /error yields a shaped error', { skip: noBash }, async () => {
  const dir = scriptProject(`#!/bin/bash
set -euo pipefail
API="http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime"
EVENT_DATA=$(curl -sS "$API/invocation/next" -D /tmp/headers.$$)
REQUEST_ID=$(grep -i Lambda-Runtime-Aws-Request-Id /tmp/headers.$$ | tr -d '[:space:]' | cut -d: -f2)
curl -sS -X POST "$API/invocation/$REQUEST_ID/error" \
  -d '{"errorMessage": "boom from bootstrap", "errorType": "HandlerError"}'
`);
  const { envelope } = await runHarness({ dir, handler: 'bootstrap' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'HandlerError');
  assert.strictEqual(envelope.error.message, 'boom from bootstrap');
});

test('bootstrap exiting without posting yields Runtime.ExitError', { skip: noBash }, async () => {
  const dir = scriptProject('#!/bin/bash\ncurl -sS "http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/next" > /dev/null\nexit 7\n');
  const { envelope } = await runHarness({ dir, handler: 'bootstrap' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'Runtime.ExitError');
  assert.ok(envelope.error.message.includes('7'));
});

test('missing executable yields Runtime.InvalidEntrypoint at init', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-prov-'));
  const { envelope } = await runHarness({ dir, handler: 'bootstrap' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.InvalidEntrypoint');
});

test('non-executable file yields Runtime.InvalidEntrypoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-prov-'));
  fs.writeFileSync(path.join(dir, 'bootstrap'), '#!/bin/bash\necho hi\n'); // no +x
  const { envelope } = await runHarness({ dir, handler: 'bootstrap' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.InvalidEntrypoint');
});

test('python-exec fixture uppercases keys via the runtime API', async () => {
  if (!hasRuntime('python3')) return; // same gate style as helpers use elsewhere
  const { envelope } = await runHarness({
    dir: path.join(FIXTURES, 'provided/python-exec'), handler: 'bootstrap',
    event: { name: 'os-runtime' } });
  assert.strictEqual(envelope.ok, true);
  assert.deepStrictEqual(envelope.response, { NAME: 'os-runtime', runtime: 'python-exec' });
});

test('provided runtime reports initMs separately from durationMs', { skip: noBash }, async () => {
  const { envelope } = await runHarness({
    dir: path.join(FIXTURES, 'provided/bash'), handler: 'bootstrap',
    event: { hello: 'world' } });
  assert.strictEqual(envelope.ok, true);
  assert.ok(envelope.initMs >= 0, `expected initMs >= 0, got ${envelope.initMs}`);
});
