const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-api-'));
const { createApp } = require('../server/index');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');
let server, baseUrl;

before(() => new Promise((resolve) => {
  server = createApp().listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

async function req(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

test('health reports runtimes', async () => {
  const { status, body } = await req('GET', '/api/health');
  assert.strictEqual(status, 200);
  assert.ok('python' in body.runtimes);
  assert.ok('node' in body.runtimes);
  assert.ok('java' in body.runtimes);
  assert.strictEqual(body.runtimes.node.available, true);
});

test('function CRUD with validation', async () => {
  let r = await req('POST', '/api/functions', { name: 'x' });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/functions', { name: 'x', path: FIXTURES, runtime: 'ruby' });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/functions', { name: 'x', path: '/no/such/dir', runtime: 'python' });
  assert.strictEqual(r.status, 400);

  r = await req('POST', '/api/functions',
    { name: 'hello', path: path.join(FIXTURES, 'python-hello'), runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;

  r = await req('GET', '/api/functions');
  assert.ok(r.body.functions.some(f => f.id === id));

  r = await req('PATCH', `/api/functions/${id}`, { timeoutMs: 5000 });
  assert.strictEqual(r.body.timeoutMs, 5000);
  r = await req('PATCH', '/api/functions/missing', {});
  assert.strictEqual(r.status, 404);

  r = await req('DELETE', `/api/functions/${id}`);
  assert.strictEqual(r.status, 204);
  r = await req('DELETE', `/api/functions/${id}`);
  assert.strictEqual(r.status, 404);
});

test('detect endpoint', async () => {
  const { body } = await req('POST', '/api/detect', { path: path.join(FIXTURES, 'python-hello') });
  assert.strictEqual(body.runtime, 'python');
  assert.deepStrictEqual(body.handlerCandidates, ['app.handler']);
});

test('invoke via API returns result; unknown id 404', { skip: noPy }, async () => {
  const created = await req('POST', '/api/functions',
    { name: 'hello2', path: path.join(FIXTURES, 'python-hello'), runtime: 'python', handler: 'app.handler' });
  const r = await req('POST', '/api/invoke', { functionId: created.body.id, event: { q: 7 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { q: 7 });
  assert.ok(r.body.report.requestId);
  const nf = await req('POST', '/api/invoke', { functionId: 'missing', event: {} });
  assert.strictEqual(nf.status, 404);
});

test('second concurrent invoke of same function -> 409', { skip: noPy }, async () => {
  const created = await req('POST', '/api/functions',
    { name: 'slow', path: path.join(FIXTURES, 'python-timeout'), runtime: 'python',
      handler: 'app.handler', timeoutMs: 3000 });
  const first = req('POST', '/api/invoke', { functionId: created.body.id, event: {} });
  await new Promise(r => setTimeout(r, 300));
  const second = await req('POST', '/api/invoke', { functionId: created.body.id, event: {} });
  assert.strictEqual(second.status, 409);
  const done = await first;
  assert.strictEqual(done.body.error.type, 'Sandbox.Timedout');
});

test('serves the frontend statically', async () => {
  const res = await fetch(baseUrl + '/');
  assert.strictEqual(res.status, 200);
});
