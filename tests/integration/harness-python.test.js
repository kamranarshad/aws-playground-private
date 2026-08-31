const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('../helpers');

const HARNESS = path.join(__dirname, '..', '..', 'harnesses', 'python', 'harness.py');
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
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

test('python runtime reports initMs separately from durationMs', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python/hello', handler: 'app.handler' });
  assert.strictEqual(envelope.ok, true);
  assert.ok(envelope.initMs >= 0, `expected initMs >= 0, got ${envelope.initMs}`);
});

// --- warm mode ---------------------------------------------------------

const { driveWarmHarness } = require('../helpers');

function pyProject(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pywarm-'));
  fs.writeFileSync(path.join(dir, 'app.py'), source);
  return dir;
}

function warmPython(dir, events) {
  return driveWarmHarness({
    cmd: 'python3', args: [HARNESS, '--handler', 'app.handler', '--result-file',
      path.join(os.tmpdir(), 'unused.json'), '--warm'],
    cwd: dir, events,
  });
}

test('a warm python harness keeps module scope across invokes', { skip }, async () => {
  const dir = pyProject('calls = 0\n\n\ndef handler(event, context):\n'
    + '    global calls\n    calls += 1\n    return {"calls": calls}\n');
  const { results } = await warmPython(dir, [{}, {}, {}]);
  assert.deepStrictEqual(results.map((r) => r.response), [
    { calls: 1 }, { calls: 2 }, { calls: 3 },
  ], 'module scope was not reused — each invoke re-imported the module');
});

test('only the first warm python invoke reports initMs', { skip }, async () => {
  const dir = pyProject('def handler(event, context):\n    return {"ok": True}\n');
  const { results } = await warmPython(dir, [{}, {}]);
  assert.strictEqual(typeof results[0].initMs, 'number');
  assert.strictEqual(results[1].initMs, undefined, 'a warm invoke must not report initMs');
});

test('each warm python invoke gets only its own logs', { skip }, async () => {
  const dir = pyProject('def handler(event, context):\n'
    + '    print("run:" + str(event["n"]))\n    return {"n": event["n"]}\n');
  const { logs } = await warmPython(dir, [{ n: 1 }, { n: 2 }]);
  assert.match(logs[0], /run:1/);
  assert.doesNotMatch(logs[0], /run:2/);
  assert.match(logs[1], /run:2/);
  assert.doesNotMatch(logs[1], /run:1/, "the second invoke's logs carried the first's output");
});

test('a python handler error does not kill the warm environment', { skip }, async () => {
  const dir = pyProject('def handler(event, context):\n'
    + '    if event.get("boom"):\n        raise ValueError("nope")\n    return {"ok": True}\n');
  const { results } = await warmPython(dir, [{ boom: true }, {}]);
  assert.strictEqual(results[0].ok, false);
  assert.strictEqual(results[0].error.message, 'nope');
  assert.strictEqual(results[1].ok, true, 'the environment died after a handler error');
});
