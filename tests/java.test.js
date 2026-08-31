const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { invoke } = require('../server/runtime/invoker');
const { hasRuntime } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'java/hello');
const JAR = path.join(FIXTURE, 'target', 'java-hello.jar');
const skip = !hasRuntime('java', ['-version']) || !fs.existsSync(JAR);

function base(extra = {}) {
  return {
    name: 'java-fn', dir: FIXTURE, runtime: 'java', jarPath: JAR,
    handler: 'example.Hello::handleRequest', event: { j: 1 }, ...extra,
  };
}

test('java RequestHandler happy path with proxied context + logger', { skip }, async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
  assert.deepStrictEqual(r.response.echo, { j: 1 });
  assert.strictEqual(r.response.requestId, r.report.requestId);
  assert.ok(r.logs.includes('hello from java logger'));
});

test('java runtime reports initMs separately from durationMs', { skip }, async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
});

test('class-only handler defaults to handleRequest', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Hello' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
});

test('unknown class -> phase:init', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Nope::handleRequest' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'init');
  assert.strictEqual(r.error.type, 'java.lang.ClassNotFoundException');
});

// Java sibling of fixtures/typescript/winston-datadog, exercised the same
// way tests/harness-node.test.js exercises the TS one: same six log
// entries, same two layouts, so the Logs tab's parser gets proven against a
// second language's timestamp/level/stack shapes too.
const LOG_FIXTURE = path.join(__dirname, '..', 'fixtures', 'java/structured-logging');
const LOG_JAR = path.join(LOG_FIXTURE, 'target', 'java-structured-logging.jar');
const logSkip = !hasRuntime('java', ['-version']) || !fs.existsSync(LOG_JAR);

function logBase(extra = {}) {
  return {
    name: 'java-log-fn', dir: LOG_FIXTURE, runtime: 'java', jarPath: LOG_JAR,
    handler: 'example.logging.OrdersApi::handleRequest', event: {}, ...extra,
  };
}

// Assert the shape rather than the wording, so rephrasing a log message
// doesn't break the test that guards the format.
test('java-structured-logging fixture: text mode leads every line with an ISO time and a level', { skip: logSkip }, async () => {
  const r = await invoke(logBase());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(r.response.body).logFormat, 'text');

  const lines = r.logs.trim().split('\n');
  const logged = lines.filter(l => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /.test(l));
  assert.deepStrictEqual(
    logged.map(l => l.split(/\s+/)[1]),
    ['DEBUG', 'INFO', 'WARN', 'ERROR', 'INFO']);

  // The bare System.out.println has neither, on purpose — it is what gives
  // the viewer a level-less row to render among the parsed ones.
  assert.ok(lines.some(l => l === 'plain System.out - no level, no timestamp'));

  // Frames only, all indented. A stack printed whole would put its
  // "NoSuchElementException: ..." line at column 0, where the viewer starts
  // a new row instead of folding — splitting one error across two.
  const frames = lines.filter(l => /^\s+at /.test(l));
  assert.ok(frames.length >= 2, `expected indented stack frames, got ${frames.length}`);
  assert.ok(!lines.some(l => l.startsWith('java.util.NoSuchElementException:')));
});

// Datadog's intake keys off `status`, not `level`, and reads error.kind /
// error.message / error.stack for error tracking.
test('java-structured-logging fixture: json mode emits Datadog standard attributes', { skip: logSkip }, async () => {
  const r = await invoke(logBase({ event: { format: 'json', orderId: 'B-2002' } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(r.response.body).orderId, 'B-2002');

  const entries = r.logs.trim().split('\n')
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l));

  assert.deepStrictEqual(entries.map(e => e.status),
    ['debug', 'info', 'warn', 'error', 'info']);
  for (const entry of entries) {
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.strictEqual(entry.service, 'orders-api');
    assert.strictEqual(entry.ddsource, 'java');
    assert.ok(entry.message);
  }

  const failure = entries.find(e => e.status === 'error');
  assert.strictEqual(failure.error.kind, 'NoSuchElementException');
  assert.match(failure.error.stack, /at example\.logging\.OrdersApi\.readFromStore/);
});
