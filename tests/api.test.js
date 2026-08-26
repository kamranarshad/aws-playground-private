const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime, writeDockerShim, writeScenario } = require('./helpers');

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

  r = api.createFunction({ name: 'hello', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;

  r = api.listFunctions();
  assert.ok(r.body.functions.some(f => f.id === id));

  r = api.updateFunction(id, { timeoutMs: 5000 });
  assert.strictEqual(r.body.timeoutMs, 5000);
  r = api.updateFunction('missing', {});
  assert.strictEqual(r.status, 404);

  // PATCH must reject the same things POST would, not just merge blindly —
  // a bad timeoutMs otherwise clamps every future invoke's timeout to ~1ms.
  r = api.updateFunction(id, { runtime: 'ruby' });
  assert.strictEqual(r.status, 400);
  r = api.updateFunction(id, { path: '/no/such/dir' });
  assert.strictEqual(r.status, 400);
  r = api.updateFunction(id, { timeoutMs: 'soon' });
  assert.strictEqual(r.status, 400);
  r = api.updateFunction(id, { memoryMb: -1 });
  assert.strictEqual(r.status, 400);
  const unaffected = api.listFunctions().body.functions.find(f => f.id === id);
  assert.strictEqual(unaffected.runtime, 'python');
  assert.strictEqual(unaffected.timeoutMs, 5000, 'rejected patches must not apply');

  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 204);
  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 404);
});

test('trigger field validation on create and update', () => {
  let r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sns', queueName: 'q', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: '', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: 'yes' } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: false } });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;
  assert.deepStrictEqual(r.body.trigger, { type: 'sqs', queueName: 'q', enabled: false });

  r = api.updateFunction(id, { trigger: { type: 'sqs', queueName: '', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.updateFunction(id, { trigger: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.trigger, null);
});

test('trigger.type "s3" requires a non-empty bucket and a non-empty valid events array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-api-s3-'));
  let r = api.createFunction({ name: 's3-val-1', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: '', events: ['ObjectCreated'], enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /bucket/);

  r = api.createFunction({ name: 's3-val-2', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: 'b', events: [], enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /events/);

  r = api.createFunction({ name: 's3-val-3', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: 'b', events: ['ObjectTagging'], enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /events/);

  r = api.createFunction({ name: 's3-val-4', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: 'b', events: ['ObjectCreated'], prefix: 1, enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /prefix/);

  r = api.createFunction({ name: 's3-val-5', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: 'b', events: ['ObjectCreated'], enabled: 'yes' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /enabled/);

  r = api.createFunction({ name: 's3-val-6', path: dir, runtime: 'node',
    trigger: { type: 's3', bucket: ' b ', events: ['ObjectCreated', 'ObjectRemoved'],
      prefix: 'images/', suffix: '.png', enabled: false } });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body.trigger,
    { type: 's3', bucket: ' b ', events: ['ObjectCreated', 'ObjectRemoved'],
      prefix: 'images/', suffix: '.png', enabled: false });
});

test('function names must be globally unique', () => {
  const a = api.createFunction({ name: 'uniq-a', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(a.status, 201);

  const dup = api.createFunction({ name: 'uniq-a', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.body.error, /already exists/);

  const b = api.createFunction({ name: 'uniq-b', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(b.status, 201);

  // Renaming into a collision is rejected...
  let r = api.updateFunction(b.body.id, { name: 'uniq-a' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /already exists/);

  // ...but saving a function's own unchanged name is not a collision with itself.
  r = api.updateFunction(a.body.id, { name: 'uniq-a' });
  assert.strictEqual(r.status, 200);
});

test('trigger.type "http" requires a boolean enabled and a name without slashes', () => {
  // This test only exercises the request-validation layer, not the trigger
  // manager's real listener wiring — stub manager.sync so enabling the HTTP
  // trigger below doesn't bind a real socket that would outlive the test.
  const manager = require('../server/trigger/manager');
  const originalSync = manager.sync;
  manager.sync = () => {};
  try {
    let r = api.createFunction({ name: 'http-trig', path: FIXTURES, runtime: 'node',
      trigger: { type: 'http', enabled: 'yes' } });
    assert.strictEqual(r.status, 400);

    r = api.createFunction({ name: 'http-trig', path: FIXTURES, runtime: 'node',
      trigger: { type: 'http', enabled: false } });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.body.trigger, { type: 'http', enabled: false });
    const id = r.body.id;

    // Enabling it is fine (name has no slash)...
    r = api.updateFunction(id, { trigger: { type: 'http', enabled: true } });
    assert.strictEqual(r.status, 200);

    // ...but a name containing '/' can't be enabled as an HTTP trigger route.
    r = api.updateFunction(id, { name: 'has/slash', trigger: { type: 'http', enabled: true } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /without .\/. characters/);
  } finally {
    manager.sync = originalSync;
  }
});

test('enabling an HTTP trigger is rejected if another function already has that name', () => {
  const a = api.createFunction({ name: 'dup-route', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(a.status, 201);
  // A grandfathered duplicate name (created before this validation existed, or
  // via a path that bypasses it) must still be caught here, not just at create time.
  const store = require('../server/store');
  store.create({ name: 'dup-route', path: FIXTURES, runtime: 'node' });

  const r = api.updateFunction(a.body.id, { trigger: { type: 'http', enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /already exists/);
});

test('a name-only rename is rejected if it would break an already-enabled HTTP trigger', () => {
  // Same reasoning as the manager.sync stub above: enabling a real HTTP
  // trigger here would bind a real socket that would outlive the test.
  const manager = require('../server/trigger/manager');
  const originalSync = manager.sync;
  manager.sync = () => {};
  try {
    const created = api.createFunction({ name: 'rename-guard', path: FIXTURES, runtime: 'node',
      trigger: { type: 'http', enabled: true } });
    assert.strictEqual(created.status, 201);

    // Renaming WITHOUT touching `trigger` in the same patch must still be
    // checked against the currently-enabled http trigger.
    const r = api.updateFunction(created.body.id, { name: 'has/slash' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /without .\/. characters/);
  } finally {
    manager.sync = originalSync;
  }
});

test('updating a function trigger notifies the trigger manager; deleting stops it', () => {
  const manager = require('../server/trigger/manager');
  const calls = { sync: [], stop: [] };
  const originalSync = manager.sync;
  const originalStop = manager.stop;
  manager.sync = (fn) => calls.sync.push(fn.id);
  manager.stop = (id) => calls.stop.push(id);
  try {
    const created = api.createFunction({ name: 'trigwire', path: FIXTURES, runtime: 'node' });
    const id = created.body.id;
    // createFunction always calls manager.sync so a trigger set at creation
    // time (via a direct API call) starts a poller immediately; sync() itself
    // is a no-op when there's no enabled trigger.
    assert.deepStrictEqual(calls.sync, [id]);

    api.updateFunction(id, { trigger: { type: 'sqs', queueName: 'q', enabled: true } });
    assert.deepStrictEqual(calls.sync, [id, id]);

    api.deleteFunction(id);
    assert.deepStrictEqual(calls.stop, [id]);
  } finally {
    manager.sync = originalSync;
    manager.stop = originalStop;
  }
});

test('GET /api/triggers reports manager status', () => {
  const manager = require('../server/trigger/manager');
  const original = manager.statusAll;
  manager.statusAll = () => ({ someId: { state: 'polling', lastError: null, lastPolledAt: 123 } });
  try {
    const r = api.listTriggerStatus();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { someId: { state: 'polling', lastError: null, lastPolledAt: 123 } });
  } finally {
    manager.statusAll = original;
  }
});

test('detect endpoint logic', () => {
  let r = api.detect({});
  assert.strictEqual(r.status, 400);
  r = api.detect({ path: path.join(FIXTURES, 'python/hello') });
  assert.strictEqual(r.body.runtime, 'python');
  assert.deepStrictEqual(r.body.handlerCandidates, ['app.handler']);
});

test('invoke returns result; unknown id 404', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hello2', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const r = await api.invokeFunction({ functionId: created.body.id, event: { q: 7 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { q: 7 });
  assert.ok(r.body.report.requestId);
  const nf = await api.invokeFunction({ functionId: 'missing', event: {} });
  assert.strictEqual(nf.status, 404);
});

test('invokeFunction tags history with the given source, defaulting to manual', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hello3', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  await api.invokeFunction({ functionId: created.body.id, event: {} });
  await api.invokeFunction({ functionId: created.body.id, event: {},
    source: { type: 'trigger', messageId: 'm1' } });
  const entries = api.listHistory(created.body.id).body.entries;
  assert.deepStrictEqual(entries[0].source, { type: 'trigger', messageId: 'm1' });
  assert.deepStrictEqual(entries[1].source, { type: 'manual' });
});

test('second concurrent invoke of same function -> 409', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'slow', path: path.join(FIXTURES, 'python/timeout'),
    runtime: 'python', handler: 'app.handler', timeoutMs: 3000 });
  const first = api.invokeFunction({ functionId: created.body.id, event: {} });
  await new Promise(r => setTimeout(r, 300));
  const second = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(second.status, 409);
  const done = await first;
  assert.strictEqual(done.body.error.type, 'Sandbox.Timedout');
});

// Regression: deleting a function while an invoke is still running used to
// succeed immediately, and the invoke completing afterward would recreate
// the just-cleared history file as an orphan no endpoint can reach again.
test('delete during an in-flight invoke is rejected (409)', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'slow-delete', path: path.join(FIXTURES, 'python/timeout'),
    runtime: 'python', handler: 'app.handler', timeoutMs: 1500 });
  const id = created.body.id;
  const invoke = api.invokeFunction({ functionId: id, event: {} });
  await new Promise(r => setTimeout(r, 300));

  const del = api.deleteFunction(id);
  assert.strictEqual(del.status, 409);

  await invoke;
  const del2 = api.deleteFunction(id);
  assert.strictEqual(del2.status, 204);
  assert.strictEqual(api.listHistory(id).status, 404);
});

test('invoke records history; delete clears it', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hist', path: path.join(FIXTURES, 'python/hello'),
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

function buildProject() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-buildproj-'));
  // "compiler": writes dist/index.js from src/index.src (hermetic, no npm)
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src', 'index.src'),
    'exports.handler = async (event) => ({ built: true, echo: event });\n');
  fs.writeFileSync(path.join(proj, 'build.mjs'),
    "import fs from 'node:fs';\n" +
    "fs.mkdirSync('dist', { recursive: true });\n" +
    "fs.copyFileSync('src/index.src', 'dist/index.js');\n" +
    "console.log('fake-tsc: compiled 1 file');\n");
  return proj;
}

test('buildCommand runs before invoke and handler hits the built output', async () => {
  const proj = buildProject();
  const created = api.createFunction({ name: 'built-fn', path: proj, runtime: 'node',
    handler: 'dist/index.handler', buildCommand: 'node build.mjs' });
  assert.strictEqual(created.body.buildCommand, 'node build.mjs');

  const r = await api.invokeFunction({ functionId: created.body.id, event: { n: 1 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response, { built: true, echo: { n: 1 } });
  assert.ok(r.body.logs.includes('=== build ==='));
  assert.ok(r.body.logs.includes('fake-tsc: compiled 1 file'));
  assert.ok(r.body.logs.includes('=== invoke ==='));
  assert.ok(typeof r.body.report.buildMs === 'number' && r.body.report.buildMs >= 0);
});

test('failing build short-circuits with Build.Failed and records history', async () => {
  const proj = buildProject();
  const created = api.createFunction({ name: 'built-fail', path: proj, runtime: 'node',
    handler: 'dist/index.handler',
    buildCommand: `node -e "console.error('TS2322: type error'); process.exit(1)"` });

  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.phase, 'build');
  assert.strictEqual(r.body.error.type, 'Build.Failed');
  assert.ok(r.body.logs.includes('TS2322: type error'));
  assert.ok(typeof r.body.report.buildMs === 'number');

  const h = api.listHistory(created.body.id);
  assert.strictEqual(h.body.entries.length, 1);
  assert.strictEqual(h.body.entries[0].ok, false);
  assert.strictEqual(h.body.entries[0].error.type, 'Build.Failed');
});

test('npm build failure without node_modules hints at npm install', async () => {
  const proj = buildProject(); // has no node_modules
  const created = api.createFunction({ name: 'built-nodeps', path: proj, runtime: 'node',
    handler: 'dist/index.handler', buildCommand: 'npm run build' });
  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.error.type, 'Build.Failed');
  assert.ok(r.body.logs.includes("run 'npm install'"),
    `expected install hint in logs, got: ${r.body.logs.slice(-300)}`);
});

test('no buildCommand leaves invoke untouched (no build markers)', async () => {
  const created = api.createFunction({ name: 'nobuild', path: path.join(FIXTURES, 'javascript/hello'),
    runtime: 'node', handler: 'index.handler' });
  assert.strictEqual(created.body.buildCommand, '');
  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(r.body.ok, true);
  assert.ok(!r.body.logs.includes('=== build ==='));
  assert.strictEqual(r.body.report.buildMs, undefined);
});

test('history write failure does not break invoke', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'histfail', path: path.join(FIXTURES, 'python/hello'),
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

test('provided runtime is accepted and invokes the bash fixture', { skip: !hasRuntime('bash', ['--version']) }, async () => {
  const created = api.createFunction({ name: 'os-bash', path: path.join(FIXTURES, 'provided/bash'),
    runtime: 'provided', handler: 'bootstrap' });
  assert.strictEqual(created.status, 201);
  const r = await api.invokeFunction({ functionId: created.body.id, event: { ping: 1 } });
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { ping: 1 });
  assert.ok(r.body.logs.includes('processing request'));
});

test('health reports the provided runtime', async () => {
  const { body } = await api.health();
  assert.ok('provided' in body.runtimes);
});

test('go bootstrap builds and invokes via the provided runtime', { skip: !hasRuntime('go', ['version']) }, async () => {
  // copy fixture to a temp dir so the built binary never lands in the repo
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-go-'));
  for (const f of ['main.go', 'go.mod']) {
    fs.copyFileSync(path.join(FIXTURES, 'provided/go', f), path.join(proj, f));
  }
  const created = api.createFunction({ name: 'os-go', path: proj, runtime: 'provided',
    handler: 'bootstrap', buildCommand: 'go build -o bootstrap .', timeoutMs: 60000 });
  const r = await api.invokeFunction({ functionId: created.body.id, event: { name: 'gopher' } });
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body.error ?? r.body).slice(0, 300));
  assert.strictEqual(r.body.response.runtime, 'go');
  assert.strictEqual(r.body.response.greeting, 'hello, gopher');
  assert.ok(r.body.logs.includes('=== build ==='));
});

// Local services (docker shim from services.test.js pattern, scoped here)
const SVC_SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-apisvc-'));
const { shim: SVC_SHIM, scenario: SVC_SCENARIO, calls: SVC_CALLS } = writeDockerShim(SVC_SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SVC_SHIM;

test('services list endpoint reports docker and per-service state', async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio running' } });
  const r = await api.listServices();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.docker.available, true);
  assert.strictEqual(r.body.services[0].state, 'running');
});

// Every invoke re-checks that the function's services are up. Probing them
// one at a time put a docker round trip per service in front of the handler.
test('invoke probes docker once however many services are enabled', async () => {
  writeScenario(SVC_SCENARIO, { ps: { code: 0, stdout: '' } });
  const proj = envEchoProject({});
  const created = api.createFunction({ name: 'svc-probe', path: proj, runtime: 'python',
    handler: 'app.handler', localServices: ['minio', 'elasticmq'] });
  fs.writeFileSync(SVC_CALLS, '');

  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });

  assert.strictEqual(r.body.error.type, 'Service.NotRunning');
  assert.ok(r.body.error.message.includes('S3 (MinIO)'), r.body.error.message);
  const calls = fs.readFileSync(SVC_CALLS, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(calls.length, 1, `one probe per invoke, got ${JSON.stringify(calls)}`);
});

test('service start/stop endpoints; unknown service 404', async () => {
  writeScenario(SVC_SCENARIO, {
    inspect: { code: 0, stdout: 'false' }, start: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: 'x' } });
  const started = await api.startService('minio', { waitReady: false });
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.state, 'running');
  const stopped = await api.stopService('minio');
  assert.strictEqual(stopped.status, 200);
  assert.strictEqual(stopped.body.state, 'stopped');
  assert.strictEqual((await api.startService('nope')).status, 404);
});

test('enabled running service injects env below UI vars', { skip: noPy }, async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } });
  const proj = envEchoProject({});
  const created = api.createFunction({ name: 'svc-env', path: proj, runtime: 'python',
    handler: 'app.handler', localServices: ['minio'],
    env: { AWS_ACCESS_KEY_ID: 'user-override' } });
  assert.deepStrictEqual(created.body.localServices, ['minio']);
  const r = await api.invokeFunction({ functionId: created.body.id,
    event: { keys: ['AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID'] } });
  assert.deepStrictEqual(r.body.response, {
    AWS_ENDPOINT_URL: 'http://127.0.0.1:9400',
    AWS_ACCESS_KEY_ID: 'user-override', // UI var beats service injection
  });
});

test('enabled but stopped service short-circuits with Service.NotRunning', async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio exited' } });
  const created = api.createFunction({ name: 'svc-down', path: path.join(FIXTURES, 'javascript/hello'),
    runtime: 'node', handler: 'index.handler', localServices: ['minio'] });
  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.phase, 'service');
  assert.strictEqual(r.body.error.type, 'Service.NotRunning');
  assert.ok(r.body.error.message.includes('S3 (MinIO)'));
  const h = api.listHistory(created.body.id);
  assert.strictEqual(h.body.entries[0].error.type, 'Service.NotRunning');

  // Each Service.NotRunning result needs its own requestId: the web UI keys
  // its result panel on report.requestId to force a remount between invokes,
  // and a shared '' would let stale per-invoke UI state carry over.
  const r2 = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.ok(r.body.report.requestId, 'requestId must not be empty');
  assert.notStrictEqual(r.body.report.requestId, r2.body.report.requestId);
});

test('unknown localServices name is rejected, not left to crash invoke or selection', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'bad-svc', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler', localServices: ['not-a-real-service'] });
  const id = created.body.id;

  const invoked = await api.invokeFunction({ functionId: id, event: {} });
  assert.strictEqual(invoked.status, 400);
  assert.match(invoked.body.error, /not-a-real-service/);

  const selected = await api.setSelection({ functionId: id, waitReady: false });
  assert.strictEqual(selected.status, 400);
  assert.match(selected.body.error, /not-a-real-service/);
});

test('two aws services: per-service endpoints, no global', { skip: noPy }, async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } });
  const proj = envEchoProject({});
  const created = api.createFunction({ name: 'multi-svc', path: proj, runtime: 'python',
    handler: 'app.handler', localServices: ['minio', 'elasticmq'] });
  const r = await api.invokeFunction({ functionId: created.body.id,
    event: { keys: ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_SQS'] } });
  assert.deepStrictEqual(r.body.response, {
    AWS_ENDPOINT_URL: null,
    AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9400',
    AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:9324',
  });
});

test('aws + plain service keeps the global endpoint', { skip: noPy }, async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } });
  const proj = envEchoProject({});
  const created = api.createFunction({ name: 'mixed-svc', path: proj, runtime: 'python',
    handler: 'app.handler', localServices: ['minio', 'redis'] });
  const r = await api.invokeFunction({ functionId: created.body.id,
    event: { keys: ['AWS_ENDPOINT_URL', 'REDIS_URL'] } });
  assert.deepStrictEqual(r.body.response, {
    AWS_ENDPOINT_URL: 'http://127.0.0.1:9400',
    REDIS_URL: 'redis://127.0.0.1:9403',
  });
});

test('playground.json services override manual toggles at invoke', { skip: noPy }, async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } });
  const proj = envEchoProject({
    'playground.json': JSON.stringify({ services: ['elasticmq'] }),
  });
  const created = api.createFunction({ name: 'file-svc', path: proj, runtime: 'python',
    handler: 'app.handler', localServices: ['minio'] }); // stale manual toggle
  const r = await api.invokeFunction({ functionId: created.body.id,
    event: { keys: ['AWS_ENDPOINT_URL_SQS', 'AWS_ENDPOINT_URL_S3'] } });
  assert.deepStrictEqual(r.body.response, {
    AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:9324', // from file
    AWS_ENDPOINT_URL_S3: null,                      // manual toggle ignored
  });
});

test('selection endpoint starts declared services; 404 unknown fn', async () => {
  writeScenario(SVC_SCENARIO, {
    ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' } });
  const proj = envEchoProject({
    'playground.json': JSON.stringify({ services: ['redis'] }),
  });
  const created = api.createFunction({ name: 'sel-svc', path: proj, runtime: 'python',
    handler: 'app.handler' });
  const r = await api.setSelection({ functionId: created.body.id, waitReady: false });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.started, ['redis']);
  assert.strictEqual((await api.setSelection({ functionId: 'missing' })).status, 404);
  const none = await api.setSelection({ functionId: null });
  assert.strictEqual(none.status, 200);
});

test('detect reports projectServices', () => {
  const proj = envEchoProject({
    'playground.json': JSON.stringify({ services: ['minio', 'nope'] }),
  });
  const r = api.detect({ path: proj });
  assert.deepStrictEqual(r.body.projectServices, ['minio']);
  const plain = api.detect({ path: path.join(FIXTURES, 'javascript/hello') });
  assert.strictEqual(plain.body.projectServices, null);
});
