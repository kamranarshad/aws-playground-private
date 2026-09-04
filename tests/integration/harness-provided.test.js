const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('../helpers');

const HARNESS = path.join(__dirname, '..', '..', 'harnesses', 'provided', 'harness.mjs');
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
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

// --- warm mode ---------------------------------------------------------

const { driveWarmHarness } = require('../helpers');

function bootstrapProject(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-provwarm-'));
  fs.writeFileSync(path.join(dir, 'bootstrap'), script);
  fs.chmodSync(path.join(dir, 'bootstrap'), 0o755);
  return dir;
}

function warmProvided(dir, events) {
  return driveWarmHarness({
    cmd: process.execPath,
    args: [HARNESS, '--handler', 'bootstrap', '--result-file',
      path.join(os.tmpdir(), 'unused.json'), '--warm'],
    cwd: dir,
    events,
  });
}

// A real custom runtime is written as a loop around /invocation/next. This is
// the runtime where warm reuse is not a compromise but the faithful shape.
const LOOPING_BOOTSTRAP = `#!/usr/bin/env bash
set -euo pipefail
while true; do
  HEADERS="$(mktemp)"
  EVENT=$(curl -sS -LD "$HEADERS" -X GET "http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/next")
  REQUEST_ID=$(grep -Fi Lambda-Runtime-Aws-Request-Id "$HEADERS" | tr -d '[:space:]' | cut -d: -f2)
  echo "serving $REQUEST_ID"
  curl -sS -X POST \\
    "http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/$REQUEST_ID/response" \\
    -d "{\\"pid\\": $$, \\"echo\\": $EVENT}" >/dev/null
done
`;

test('the bootstrap process survives between warm invokes', { skip: noBash }, async () => {
  const dir = bootstrapProject(LOOPING_BOOTSTRAP);
  const { results } = await warmProvided(dir, [{ n: 1 }, { n: 2 }, { n: 3 }]);

  for (const r of results) assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const pids = new Set(results.map((r) => r.response.pid));
  assert.strictEqual(pids.size, 1,
    `the bootstrap was restarted between invokes (pids: ${[...pids].join(', ')})`);
  assert.deepStrictEqual(results.map((r) => r.response.echo), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('only the first warm provided invoke reports initMs', { skip: noBash }, async () => {
  const dir = bootstrapProject(LOOPING_BOOTSTRAP);
  const { results } = await warmProvided(dir, [{ n: 1 }, { n: 2 }]);
  assert.strictEqual(typeof results[0].initMs, 'number');
  assert.strictEqual(results[1].initMs, undefined, 'a warm invoke must not report initMs');
});

test('each warm provided invoke gets only its own logs', { skip: noBash }, async () => {
  const dir = bootstrapProject(LOOPING_BOOTSTRAP);
  const { results, logs } = await warmProvided(dir, [{ n: 1 }, { n: 2 }]);
  const ids = results.map((r) => r.report?.requestId);
  assert.match(logs[0], /serving /);
  // Each invoke's bootstrap output must land in that invoke's logs, not bleed
  // into the next one's.
  assert.strictEqual((logs[1].match(/serving /g) ?? []).length, 1,
    `the second invoke's logs carried more than its own output: ${JSON.stringify(logs[1])}`);
  assert.ok(ids.length === 2);
});

// A real AWS custom runtime loops on /invocation/next, but a hand-written
// local bootstrap often serves one invocation and exits -- which worked fine
// when every invoke got its own process. Reusing the environment must not
// break it: the harness gives up its environment so the next invoke cold
// starts a fresh bootstrap, exactly as before.
const ONE_SHOT_BOOTSTRAP = `#!/usr/bin/env bash
set -euo pipefail
HEADERS="$(mktemp)"
curl -sS -LD "$HEADERS" -X GET "http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/next" >/dev/null
REQUEST_ID=$(grep -Fi Lambda-Runtime-Aws-Request-Id "$HEADERS" | tr -d '[:space:]' | cut -d: -f2)
curl -sS -X POST \\
  "http://$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/$REQUEST_ID/response" \\
  -d '{"served":true}' >/dev/null
`;

test('a bootstrap that exits after one invocation still serves the next one',
  { skip: noBash }, async (t) => {
  const { invoke } = require('../../server/runtime/invoker');
  const pool = require('../../server/runtime/pool');
  t.after(() => pool.shutdown());

  const dir = bootstrapProject(ONE_SHOT_BOOTSTRAP);
  const base = { id: 'one-shot-fn', runtime: 'provided', dir, handler: 'bootstrap',
    event: {}, timeoutMs: 10000 };

  const first = await invoke(base);
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  assert.deepStrictEqual(first.response, { served: true });

  const second = await invoke(base);
  assert.strictEqual(second.ok, true,
    `a non-looping bootstrap broke on the second invoke: ${JSON.stringify(second.error)}`);
  assert.deepStrictEqual(second.response, { served: true });
  assert.strictEqual(second.report.cold, true,
    'the bootstrap had to be restarted, so this was not a warm invoke');
});
