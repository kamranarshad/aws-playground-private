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

  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 204);
  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 404);
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
  const created = api.createFunction({ name: 'nobuild', path: path.join(FIXTURES, 'node/hello'),
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
const SVC_SCENARIO = path.join(SVC_SHIM_DIR, 'scenario.json');
const SVC_CALLS = path.join(SVC_SHIM_DIR, 'calls.log');
fs.writeFileSync(path.join(SVC_SHIM_DIR, 'docker'), `#!/bin/bash
echo "$@" >> "${SVC_CALLS}"
# Subcommand travels via env, not argv: a bare "inspect" argv would trigger
# node's own debugger CLI.
out=$(DOCKER_SUBCMD="$1" node -pe 'const s=JSON.parse(require("fs").readFileSync("${SVC_SCENARIO}")); JSON.stringify(s[process.env.DOCKER_SUBCMD] ?? {code:1,stdout:""})')
code=$(SHIM_OUT="$out" node -pe 'JSON.parse(process.env.SHIM_OUT).code')
SHIM_OUT="$out" node -pe 'JSON.parse(process.env.SHIM_OUT).stdout'
exit "$code"
`);
fs.chmodSync(path.join(SVC_SHIM_DIR, 'docker'), 0o755);
process.env.AWS_PLAYGROUND_DOCKER = path.join(SVC_SHIM_DIR, 'docker');

test('services list endpoint reports docker and per-service state', async () => {
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio running' } }));
  const r = await api.listServices();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.docker.available, true);
  assert.strictEqual(r.body.services[0].state, 'running');
});

// Every invoke re-checks that the function's services are up. Probing them
// one at a time put a docker round trip per service in front of the handler.
test('invoke probes docker once however many services are enabled', async () => {
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({ ps: { code: 0, stdout: '' } }));
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
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    inspect: { code: 0, stdout: 'false' }, start: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: 'x' } }));
  const started = await api.startService('minio', { waitReady: false });
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.state, 'running');
  const stopped = await api.stopService('minio');
  assert.strictEqual(stopped.status, 200);
  assert.strictEqual(stopped.body.state, 'stopped');
  assert.strictEqual((await api.startService('nope')).status, 404);
});

test('enabled running service injects env below UI vars', { skip: noPy }, async () => {
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } }));
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
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio exited' } }));
  const created = api.createFunction({ name: 'svc-down', path: path.join(FIXTURES, 'node/hello'),
    runtime: 'node', handler: 'index.handler', localServices: ['minio'] });
  const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.phase, 'service');
  assert.strictEqual(r.body.error.type, 'Service.NotRunning');
  assert.ok(r.body.error.message.includes('S3 (MinIO)'));
  const h = api.listHistory(created.body.id);
  assert.strictEqual(h.body.entries[0].error.type, 'Service.NotRunning');
});

test('two aws services: per-service endpoints, no global', { skip: noPy }, async () => {
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } }));
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
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } }));
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
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: 'aws-playground-minio running\naws-playground-elasticmq running\naws-playground-dynamodb running\naws-playground-redis running\naws-playground-postgres running' } }));
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
  fs.writeFileSync(SVC_SCENARIO, JSON.stringify({
    ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' } }));
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
  const plain = api.detect({ path: path.join(FIXTURES, 'node/hello') });
  assert.strictEqual(plain.body.projectServices, null);
});
