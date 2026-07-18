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
    fixture: 'node-apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'GET', path: '/hello', query: { name: 'Kamran' } }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 200);
  assert.strictEqual(envelope.response.headers['content-type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { message: 'hello, Kamran' });
});

test('apigw fixture: POST /echo returns base64-decoded JSON body', async () => {
  const payload = { order: 42, items: ['a', 'b'] };
  const { envelope } = await runHarness({
    fixture: 'node-apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'POST', path: '/echo',
      body: Buffer.from(JSON.stringify(payload)).toString('base64'), isBase64Encoded: true }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { received: payload });
});

test('apigw fixture: POST /echo with invalid JSON -> 400', async () => {
  const { envelope } = await runHarness({
    fixture: 'node-apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'POST', path: '/echo', body: 'not json{' }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { error: 'invalid JSON body' });
});

test('apigw fixture: unknown route -> 404', async () => {
  const { envelope } = await runHarness({
    fixture: 'node-apigw', handler: 'index.handler',
    event: apigwEvent({ method: 'DELETE', path: '/nope' }) });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(envelope.response.body), { error: 'not found' });
});

test('apigw fixture: shipped sample events drive the handler', async () => {
  const eventsDir = path.join(FIXTURES, 'node-apigw', 'events');
  const getHello = JSON.parse(fs.readFileSync(path.join(eventsDir, 'get-hello.json'), 'utf8'));
  const postEcho = JSON.parse(fs.readFileSync(path.join(eventsDir, 'post-echo.json'), 'utf8'));

  const hello = await runHarness({ fixture: 'node-apigw', handler: 'index.handler', event: getHello });
  assert.strictEqual(hello.envelope.response.statusCode, 200);
  assert.match(JSON.parse(hello.envelope.response.body).message, /^hello, /);

  const echo = await runHarness({ fixture: 'node-apigw', handler: 'index.handler', event: postEcho });
  assert.strictEqual(echo.envelope.response.statusCode, 200);
  assert.ok(JSON.parse(echo.envelope.response.body).received);
});

test('malformed handler string -> phase:init Runtime.MalformedHandlerName', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'nodots' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.MalformedHandlerName');
});
