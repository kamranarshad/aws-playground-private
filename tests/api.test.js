const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-api-'));
const api = require('../server/api');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');

test('health reports runtimes', async () => {
  const { status, body } = await api.health();
  assert.strictEqual(status, 200);
  assert.ok('python' in body.runtimes);
  assert.ok('node' in body.runtimes);
  assert.ok('java' in body.runtimes);
  assert.strictEqual(body.runtimes.node.available, true);
});

test('function CRUD with validation', async () => {
  let r = api.createFunction({ name: 'x' });
  assert.strictEqual(r.status, 400);
  r = api.createFunction({ name: 'x', path: FIXTURES, runtime: 'ruby' });
  assert.strictEqual(r.status, 400);
  r = api.createFunction({ name: 'x', path: '/no/such/dir', runtime: 'python' });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'hello', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;

  r = api.listFunctions();
  assert.ok(r.body.functions.some(f => f.id === id));

  r = api.updateFunction(id, { timeoutMs: 5000 });
  assert.strictEqual(r.body.timeoutMs, 5000);
  r = api.updateFunction('missing', {});
  assert.strictEqual(r.status, 404);

  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 204);
  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 404);
});

test('detect endpoint logic', () => {
  let r = api.detect({});
  assert.strictEqual(r.status, 400);
  r = api.detect({ path: path.join(FIXTURES, 'python-hello') });
  assert.strictEqual(r.body.runtime, 'python');
  assert.deepStrictEqual(r.body.handlerCandidates, ['app.handler']);
});

test('invoke returns result; unknown id 404', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hello2', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  const r = await api.invokeFunction({ functionId: created.body.id, event: { q: 7 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { q: 7 });
  assert.ok(r.body.report.requestId);
  const nf = await api.invokeFunction({ functionId: 'missing', event: {} });
  assert.strictEqual(nf.status, 404);
});

test('second concurrent invoke of same function -> 409', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'slow', path: path.join(FIXTURES, 'python-timeout'),
    runtime: 'python', handler: 'app.handler', timeoutMs: 3000 });
  const first = api.invokeFunction({ functionId: created.body.id, event: {} });
  await new Promise(r => setTimeout(r, 300));
  const second = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(second.status, 409);
  const done = await first;
  assert.strictEqual(done.body.error.type, 'Sandbox.Timedout');
});

test('invoke records history; delete clears it', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hist', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  const id = created.body.id;

  let h = api.listHistory(id);
  assert.strictEqual(h.status, 200);
  assert.deepStrictEqual(h.body.entries, []);

  await api.invokeFunction({ functionId: id, event: { q: 1 } });
  h = api.listHistory(id);
  assert.strictEqual(h.body.entries.length, 1);
  assert.strictEqual(h.body.entries[0].ok, true);
  assert.deepStrictEqual(h.body.entries[0].event, { q: 1 });
  assert.ok(h.body.entries[0].report.requestId);

  const cleared = api.clearHistory(id);
  assert.strictEqual(cleared.status, 204);
  assert.deepStrictEqual(api.listHistory(id).body.entries, []);

  await api.invokeFunction({ functionId: id, event: {} });
  api.deleteFunction(id);
  assert.strictEqual(api.listHistory(id).status, 404);
  const history = require('../server/history');
  assert.deepStrictEqual(history.list(id), []);
});

test('history endpoints 404 for unknown function', () => {
  assert.strictEqual(api.listHistory('missing').status, 404);
  assert.strictEqual(api.clearHistory('missing').status, 404);
});

function envEchoProject(files) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-envproj-'));
  fs.writeFileSync(path.join(proj, 'app.py'),
    'import os\n' +
    'def handler(event, context):\n' +
    '    return {k: os.environ.get(k) for k in event.get("keys", [])}\n');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(proj, name), content);
  }
  return proj;
}

test('invoke loads project .env with file < UI < per-invoke precedence', { skip: noPy }, async () => {
  const proj = envEchoProject({
    '.env': 'FROM_FILE=file\nUI_WINS=file\nINVOKE_WINS=file\n',
    '.env.local': 'FROM_LOCAL=local\n',
  });
  const created = api.createFunction({ name: 'envfile-auto', path: proj,
    runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(created.body.envFile, 'auto');
  const id = created.body.id;
  api.updateFunction(id, { env: { UI_WINS: 'ui' } });

  const keys = ['FROM_FILE', 'UI_WINS', 'INVOKE_WINS', 'FROM_LOCAL'];
  const r = await api.invokeFunction({ functionId: id, event: { keys },
    envVars: { INVOKE_WINS: 'invoke' } });
  assert.deepStrictEqual(r.body.response, {
    FROM_FILE: 'file',      // from .env (auto)
    UI_WINS: 'ui',          // UI var beats file
    INVOKE_WINS: 'invoke',  // per-invoke beats file
    FROM_LOCAL: null,       // .env.local not selected
  });
});

test('invoke honors envFile none and a specific file', { skip: noPy }, async () => {
  const proj = envEchoProject({
    '.env': 'MARKER=dotenv\n',
    '.env.local': 'MARKER=local\n',
  });
  const created = api.createFunction({ name: 'envfile-sel', path: proj,
    runtime: 'python', handler: 'app.handler' });
  const id = created.body.id;

  api.updateFunction(id, { envFile: 'none' });
  let r = await api.invokeFunction({ functionId: id, event: { keys: ['MARKER'] } });
  assert.deepStrictEqual(r.body.response, { MARKER: null });

  api.updateFunction(id, { envFile: '.env.local' });
  r = await api.invokeFunction({ functionId: id, event: { keys: ['MARKER'] } });
  assert.deepStrictEqual(r.body.response, { MARKER: 'local' });
});

test('detect lists env files', () => {
  const proj = envEchoProject({ '.env': '', '.env.production': '' });
  const r = api.detect({ path: proj });
  assert.deepStrictEqual(r.body.envFiles, ['.env', '.env.production']);
});

test('history write failure does not break invoke', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'histfail', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  const histDir = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'history');
  fs.rmSync(histDir, { recursive: true, force: true });
  fs.writeFileSync(histDir, 'block'); // a file where the history dir should be -> append throws
  try {
    const r = await api.invokeFunction({ functionId: created.body.id, event: { q: 1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  } finally {
    fs.rmSync(histDir, { force: true });
  }
});
