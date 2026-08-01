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
    fixture: 'javascript/hello', handler: 'index.handler', event: { b: 2 } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.response.message, 'hello from node');
  assert.deepStrictEqual(envelope.response.echo, { b: 2 });
  assert.strictEqual(envelope.response.requestId, 'req-test-2');
  assert.strictEqual(envelope.response.remaining, true);
  assert.ok(stdout.includes('node log line'));
});

test('callback-style handler resolves via callback', async () => {
  const { envelope } = await runHarness({ fixture: 'javascript/hello', handler: 'index.callbackHandler' });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.message, 'hello from callback');
});

test('thrown error -> ok:false phase:invoke', async () => {
  const { envelope } = await runHarness({ fixture: 'javascript/hello', handler: 'index.errorHandler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'TypeError');
  assert.strictEqual(envelope.error.message, 'boom from node');
});

test('missing file -> phase:init Runtime.ImportModuleError', async () => {
  const { envelope } = await runHarness({ fixture: 'javascript/hello', handler: 'missing.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.ImportModuleError');
});

test('missing export -> phase:init Runtime.HandlerNotFound', async () => {
  const { envelope } = await runHarness({ fixture: 'javascript/hello', handler: 'index.nope' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.HandlerNotFound');
});

function apigwEvent({ method = 'GET', path = '/', query, body, isBase64Encoded = false } = {}) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    queryStringParameters: query,
    requestContext: { http: { method, path } },
    body,
    isBase64Encoded,
  };
}

test('apigw fixture: GET /hello greets by query param', async () => {
  const { envelope } = await runHarness({
    fixture: 'javascript/apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'GET', path: '/hello', query: { name: 'Kamran' } }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 200);
  assert.strictEqual(envelope.response.headers['content-type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { message: 'hello, Kamran' });
});

test('apigw fixture: POST /echo returns base64-decoded JSON body', async () => {
  const payload = { order: 42, items: ['a', 'b'] };
  const { envelope } = await runHarness({
    fixture: 'javascript/apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'POST', path: '/echo',
      body: Buffer.from(JSON.stringify(payload)).toString('base64'), isBase64Encoded: true }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { received: payload });
});

test('apigw fixture: POST /echo with invalid JSON -> 400', async () => {
  const { envelope } = await runHarness({
    fixture: 'javascript/apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'POST', path: '/echo', body: 'not json{' }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { error: 'invalid JSON body' });
});

test('apigw fixture: unknown route -> 404', async () => {
  const { envelope } = await runHarness({
    fixture: 'javascript/apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'DELETE', path: '/nope' }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { error: 'not found' });
});

test('apigw fixture: shipped sample events drive the handler', async () => {
  const eventsDir = path.join(FIXTURES, 'javascript/apigw', 'events');
  const getHello = JSON.parse(fs.readFileSync(path.join(eventsDir, 'get-hello.json'), 'utf8'));
  const postEcho = JSON.parse(fs.readFileSync(path.join(eventsDir, 'post-echo.json'), 'utf8'));

  const hello = await runHarness({ fixture: 'javascript/apigw', handler: 'index.handler', event: getHello });
  assert.strictEqual(hello.envelope.response.statusCode, 200);
  assert.match(JSON.parse(hello.envelope.response.body).message, /^hello, /);

  const echo = await runHarness({ fixture: 'javascript/apigw', handler: 'index.handler', event: postEcho });
  assert.strictEqual(echo.envelope.response.statusCode, 200);
  assert.ok(JSON.parse(echo.envelope.response.body).received);
});

test('ts-apigw fixture: GET /hello via committed dist build', async () => {
  const { envelope } = await runHarness({
    fixture: 'typescript/apigw', handler: 'dist/index.handler',
    event: apigwEvent({ method: 'GET', path: '/hello', query: { name: 'TS' } }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(envelope.response.body),
    { message: 'hello, TS (typescript)' });
});

test('ts-apigw fixture: POST /sum adds numbers, 400 on bad body', async () => {
  const ok = await runHarness({
    fixture: 'typescript/apigw', handler: 'dist/index.handler',
    event: apigwEvent({ method: 'POST', path: '/sum', body: '[1,2,3.5]' }) });
  assert.strictEqual(ok.envelope.response.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(ok.envelope.response.body), { sum: 6.5 });

  const bad = await runHarness({
    fixture: 'typescript/apigw', handler: 'dist/index.handler',
    event: apigwEvent({ method: 'POST', path: '/sum', body: '{"not":"array"}' }) });
  assert.strictEqual(bad.envelope.response.statusCode, 400);
});

// The text layout is the one the Logs tab parses: a leading ISO timestamp,
// then the level. Assert the shape rather than the wording, so rephrasing a
// log message doesn't break the test that guards the format.
test('ts-winston fixture: text mode leads every line with an ISO time and a level', async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'typescript/winston-datadog', handler: 'dist/index.handler', event: {} });

  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(JSON.parse(envelope.response.body).logFormat, 'text');

  const lines = stdout.trim().split('\n');
  const logged = lines.filter(l => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /.test(l));
  assert.deepStrictEqual(
    logged.map(l => l.split(/\s+/)[1]),
    ['DEBUG', 'INFO', 'WARN', 'ERROR', 'INFO']);

  // The bare console.log has neither, on purpose — it is what gives the
  // viewer a level-less row to render among the parsed ones.
  assert.ok(lines.some(l => l === 'plain console.log - no level, no timestamp'));

  // Frames only, all indented. A stack printed whole would put its
  // "RangeError: ..." line at column 0, where the viewer starts a new row
  // instead of folding — splitting one error across two.
  const frames = lines.filter(l => /^\s+at /.test(l));
  assert.ok(frames.length >= 2, `expected indented stack frames, got ${frames.length}`);
  assert.ok(!lines.some(l => /^RangeError:/.test(l)));
});

// Datadog's intake keys off `status`, not `level`, and reads error.kind /
// error.message / error.stack for error tracking.
test('ts-winston fixture: json mode emits Datadog standard attributes', async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'typescript/winston-datadog', handler: 'dist/index.handler',
    event: { format: 'json', orderId: 'B-2002' } });

  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(JSON.parse(envelope.response.body).orderId, 'B-2002');

  const entries = stdout.trim().split('\n')
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l));

  assert.deepStrictEqual(entries.map(e => e.status),
    ['debug', 'info', 'warn', 'error', 'info']);
  for (const entry of entries) {
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.strictEqual(entry.service, 'orders-api');
    assert.strictEqual(entry.ddsource, 'nodejs');
    assert.ok(entry.message);
  }

  const failure = entries.find(e => e.status === 'error');
  assert.strictEqual(failure.error.kind, 'RangeError');
  assert.match(failure.error.stack, /at readFromStore/);
});

test('malformed handler string -> phase:init Runtime.MalformedHandlerName', async () => {
  const { envelope } = await runHarness({ fixture: 'javascript/hello', handler: 'nodots' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.MalformedHandlerName');
});
