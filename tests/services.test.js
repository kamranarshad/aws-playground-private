const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hermetic: point services.js at a shim "docker" that scripts responses
// and records argv, so no real docker is needed.
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-svc-'));
const SHIM = path.join(SHIM_DIR, 'docker');
const CALLS = path.join(SHIM_DIR, 'calls.log');
const SCENARIO = path.join(SHIM_DIR, 'scenario.json');
fs.writeFileSync(SHIM, `#!/bin/bash
echo "$@" >> "${CALLS}"
key="$1 $2"
out=$(node -pe 'const s=JSON.parse(require("fs").readFileSync("${SCENARIO}")); const k=process.argv[1]; JSON.stringify(s[k] ?? s[process.argv[2]] ?? {code:1,stdout:""})' "$key" "$1")
code=$(node -pe 'JSON.parse(process.argv[1]).code' "$out")
node -pe 'JSON.parse(process.argv[1]).stdout' "$out"
exit "$code"
`);
fs.chmodSync(SHIM, 0o755);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;

const services = require('../server/services');

function scenario(map) {
  fs.writeFileSync(SCENARIO, JSON.stringify(map));
  fs.writeFileSync(CALLS, '');
}

function calls() {
  return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean);
}

test('status: absent, stopped, running', async () => {
  scenario({ inspect: { code: 1, stdout: '' } });
  assert.strictEqual(await services.status('minio'), 'absent');
  scenario({ inspect: { code: 0, stdout: 'false' } });
  assert.strictEqual(await services.status('minio'), 'stopped');
  scenario({ inspect: { code: 0, stdout: 'true' } });
  assert.strictEqual(await services.status('minio'), 'running');
});

test('start runs a new container with volume, loopback ports, creds', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'abc123' } });
  const r = await services.start('minio', { waitReady: false });
  assert.strictEqual(r.ok, true);
  const runCall = calls().find(c => c.startsWith('run'));
  assert.ok(runCall.includes('--name aws-playground-minio'));
  assert.ok(runCall.includes('-v aws-playground-minio-data:/data'));
  assert.ok(runCall.includes('-p 127.0.0.1:9400:9000'));
  assert.ok(runCall.includes('-p 127.0.0.1:9401:9001'));
  assert.ok(runCall.includes('MINIO_ROOT_USER=playground'));
  assert.ok(runCall.includes('minio/minio server /data'));
});

test('start reuses an existing stopped container via docker start', async () => {
  scenario({ inspect: { code: 0, stdout: 'false' }, start: { code: 0, stdout: 'aws-playground-minio' } });
  const r = await services.start('minio', { waitReady: false });
  assert.strictEqual(r.ok, true);
  assert.ok(calls().some(c => c.startsWith('start aws-playground-minio')));
  assert.ok(!calls().some(c => c.startsWith('run')));
});

test('start failure surfaces output without throwing', async () => {
  scenario({ inspect: { code: 1, stdout: '' },
    run: { code: 125, stdout: 'port is already allocated' } });
  const r = await services.start('minio', { waitReady: false });
  assert.strictEqual(r.ok, false);
  assert.ok(r.output.includes('port is already allocated'));
});

test('stop stops the container', async () => {
  scenario({ stop: { code: 0, stdout: 'aws-playground-minio' } });
  const r = await services.stop('minio');
  assert.strictEqual(r.ok, true);
  assert.ok(calls().some(c => c.startsWith('stop aws-playground-minio')));
});

test('unknown service is rejected', async () => {
  await assert.rejects(() => services.status('nope'), /unknown service/);
});

test('list shapes registry + status for the API', async () => {
  scenario({ ps: { code: 0, stdout: 'aws-playground-minio running' } });
  const r = await services.list();
  assert.strictEqual(r.docker.available, true);
  const minio = r.services.find(s => s.name === 'minio');
  assert.strictEqual(minio.label, 'S3 (MinIO)');
  assert.strictEqual(minio.state, 'running');
  assert.strictEqual(minio.endpoint, 'http://127.0.0.1:9400');
  assert.strictEqual(minio.consoleUrl, 'http://127.0.0.1:9401');
});


test('elasticmq: run args, no volume, sqs endpoint env', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.start('elasticmq', { waitReady: false });
  const run = calls().find(c => c.startsWith('run'));
  assert.ok(run.includes('--name aws-playground-elasticmq'));
  assert.ok(run.includes('-p 127.0.0.1:9324:9324'));
  assert.ok(run.includes('-p 127.0.0.1:9325:9325'));
  assert.ok(!run.includes('-v '), 'elasticmq must not mount a volume');
  assert.ok(run.includes('softwaremill/elasticmq-native'));
  assert.deepStrictEqual(services.envFor('elasticmq'),
    { AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:9324' });
});

test('dynamodb: sharedDb + volume + dbPath', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.start('dynamodb', { waitReady: false });
  const run = calls().find(c => c.startsWith('run'));
  assert.ok(run.includes('--name aws-playground-dynamodb'));
  assert.ok(run.includes('-p 127.0.0.1:9402:8000'));
  assert.ok(run.includes('-v aws-playground-dynamodb-data:/home/dynamodblocal/data'));
  assert.ok(run.includes('amazon/dynamodb-local'));
  assert.ok(run.includes('-sharedDb'));
  assert.ok(run.includes('-dbPath /home/dynamodblocal/data'));
  assert.deepStrictEqual(services.envFor('dynamodb'),
    { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:9402' });
});

test('redis and postgres: volumes, ports, plain-endpoint env', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.start('redis', { waitReady: false });
  let run = calls().find(c => c.startsWith('run'));
  assert.ok(run.includes('-p 127.0.0.1:9403:6379'));
  assert.ok(run.includes('-v aws-playground-redis-data:/data'));
  assert.ok(run.includes('redis:alpine server') === false); // command is redis-server
  assert.ok(run.includes('--appendonly yes'));
  assert.deepStrictEqual(services.envFor('redis'), { REDIS_URL: 'redis://127.0.0.1:9403' });

  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.start('postgres', { waitReady: false });
  run = calls().find(c => c.startsWith('run'));
  assert.ok(run.includes('-p 127.0.0.1:9404:5432'));
  // postgres 18+ images require the mount at /var/lib/postgresql (not .../data)
  assert.ok(run.includes('-v aws-playground-postgres-data:/var/lib/postgresql'));
  assert.ok(!run.includes(':/var/lib/postgresql/data'));
  assert.ok(run.includes('POSTGRES_PASSWORD=playground123'));
  const env = services.envFor('postgres');
  assert.strictEqual(env.DATABASE_URL, 'postgresql://playground:playground123@127.0.0.1:9404/playground');
  assert.strictEqual(env.PGPORT, '9404');
});

test('composeEnv: single aws service gets global endpoint + creds', () => {
  const env = services.composeEnv(['minio']);
  assert.strictEqual(env.AWS_ENDPOINT_URL, 'http://127.0.0.1:9400');
  assert.strictEqual(env.AWS_ENDPOINT_URL_S3, 'http://127.0.0.1:9400');
  assert.strictEqual(env.AWS_ACCESS_KEY_ID, 'playground');
});

test('composeEnv: two aws services -> per-service vars only, no global', () => {
  const env = services.composeEnv(['minio', 'elasticmq']);
  assert.strictEqual(env.AWS_ENDPOINT_URL, undefined);
  assert.strictEqual(env.AWS_ENDPOINT_URL_S3, 'http://127.0.0.1:9400');
  assert.strictEqual(env.AWS_ENDPOINT_URL_SQS, 'http://127.0.0.1:9324');
  assert.strictEqual(env.AWS_ACCESS_KEY_ID, 'playground');
});

test('composeEnv: aws + plain keeps global; plain only has no AWS vars', () => {
  const mixed = services.composeEnv(['minio', 'redis']);
  assert.strictEqual(mixed.AWS_ENDPOINT_URL, 'http://127.0.0.1:9400');
  assert.strictEqual(mixed.REDIS_URL, 'redis://127.0.0.1:9403');
  const plain = services.composeEnv(['redis', 'postgres']);
  assert.strictEqual(plain.AWS_ENDPOINT_URL, undefined);
  assert.strictEqual(plain.AWS_ACCESS_KEY_ID, undefined);
  assert.strictEqual(plain.REDIS_URL, 'redis://127.0.0.1:9403');
  assert.ok(plain.DATABASE_URL);
});

test('minio envFor no longer carries creds or global endpoint', () => {
  assert.deepStrictEqual(services.envFor('minio'),
    { AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9400' });
});

// --- selection lifecycle (auto-start / grace auto-stop) ---
process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS = '120';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll for an expected call rather than sleeping a fixed amount: the shim
// spawns node subprocesses, and under a parallel test run those can take far
// longer than the grace window, which used to make these tests flaky.
async function waitForCall(prefix, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls().some(c => c.startsWith(prefix))) return true;
    await sleep(20);
  }
  return false;
}

// For "this must NOT happen", there is nothing to poll for — wait well past
// the grace window so a pass means the timer really was cancelled, not that
// it simply hadn't fired yet.
const PAST_GRACE_MS = 8 * parseInt(process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS, 10);

test('setSelection starts missing services and auto-stops after grace', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: 'x' } });
  const r = await services.setSelection(['minio'], { waitReady: false });
  assert.deepStrictEqual(r.started, ['minio']);
  assert.ok(calls().some(c => c.startsWith('run')));

  // shim now reports running so status checks agree
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  const r2 = await services.setSelection([], { waitReady: false });
  assert.deepStrictEqual(r2.scheduledStop, ['minio']);
  assert.ok(await waitForCall('stop aws-playground-minio'),
    'auto-started service should stop after grace');
});

test('reselection within grace cancels the pending stop', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.setSelection(['elasticmq'], { waitReady: false });
  scenario({ ps: { code: 0, stdout: 'aws-playground-elasticmq running' } });
  await services.setSelection([], { waitReady: false });
  await services.setSelection(['elasticmq'], { waitReady: false }); // back within grace
  scenario({ ps: { code: 0, stdout: 'aws-playground-elasticmq running' } }); // fresh call log
  await sleep(PAST_GRACE_MS);
  assert.ok(!calls().some(c => c.startsWith('stop aws-playground-elasticmq')),
    'stop must be cancelled by reselection');
  // cleanup state for later tests
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await services.setSelection([], { waitReady: false });
  await sleep(PAST_GRACE_MS);
});

// Regression: the pending stop must be cancelled in setSelection's synchronous
// prologue, not after it awaits docker. Grace is set below the shim's probe
// time and the call is deliberately not awaited, so if the cancel sits behind
// the probe the timer is guaranteed to fire first and stop a selected service.
test('reselection cancels the pending stop before awaiting docker', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.setSelection(['elasticmq'], { waitReady: false });
  scenario({ ps: { code: 0, stdout: 'aws-playground-elasticmq running' },
    inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });

  const prevGrace = process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS;
  process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS = '5';
  try {
    await services.setSelection([], { waitReady: false }); // arms a 5ms stop
    scenario({ ps: { code: 0, stdout: 'aws-playground-elasticmq running' } });
    // Not awaited: the synchronous prologue must already have cancelled it.
    const reselect = services.setSelection(['elasticmq'], { waitReady: false });
    await sleep(200);
    await reselect;
    assert.ok(!calls().some(c => c.startsWith('stop aws-playground-elasticmq')),
      'stop must be cancelled before the docker probe, not after');
  } finally {
    process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS = prevGrace;
  }

  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await services.setSelection([], { waitReady: false });
  await sleep(PAST_GRACE_MS);
});

test('already-running services are not adopted for auto-stop', async () => {
  scenario({ ps: { code: 0, stdout: 'aws-playground-redis running' },
    stop: { code: 0, stdout: 'x' } });
  const r = await services.setSelection(['redis'], { waitReady: false });
  assert.deepStrictEqual(r.started, []); // was already running (user-started)
  await services.setSelection([], { waitReady: false });
  await sleep(PAST_GRACE_MS);
  assert.ok(!calls().some(c => c.startsWith('stop aws-playground-redis')),
    'user-started service must never auto-stop');
});

test('manual start promotes an auto-started service (no auto-stop)', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.setSelection(['dynamodb'], { waitReady: false });
  scenario({ inspect: { code: 0, stdout: 'true' } });
  await services.start('dynamodb', { waitReady: false }); // manual promotion
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await services.setSelection([], { waitReady: false });
  await sleep(PAST_GRACE_MS);
  assert.ok(!calls().some(c => c.startsWith('stop aws-playground-dynamodb')),
    'manually promoted service must not auto-stop');
});

// Selection changes on every click through the function list, so probing
// each declared service separately made the cost scale with the project.
test('setSelection probes docker once for the whole selection', async () => {
  scenario({ ps: { code: 0, stdout:
    'aws-playground-minio running\naws-playground-redis running' } });

  await services.setSelection(['minio', 'redis'], { waitReady: false });

  assert.strictEqual(calls().length, 1,
    `one probe for the whole selection, got: ${JSON.stringify(calls())}`);
});

test('stopAutoStarted stops auto-started services and leaves user-started ones', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.setSelection(['minio', 'redis'], { waitReady: false });
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await services.start('redis', { waitReady: false }); // promote redis to user-managed

  const stopped = await services.stopAutoStarted();

  assert.deepStrictEqual(stopped, ['minio']);
  assert.ok(calls().some(c => c.startsWith('stop aws-playground-minio')));
  assert.ok(!calls().some(c => c.startsWith('stop aws-playground-redis')),
    'a user-started service must survive shutdown sweep');
});

test('stopAutoStarted clears pending grace timers so nothing stops twice', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 0, stdout: 'x' } });
  await services.setSelection(['elasticmq'], { waitReady: false });
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await services.setSelection([], { waitReady: false }); // schedules a grace stop

  await services.stopAutoStarted();
  scenario({ inspect: { code: 0, stdout: 'true' }, stop: { code: 0, stdout: 'x' } });
  await sleep(PAST_GRACE_MS); // past the grace window

  assert.ok(!calls().some(c => c.startsWith('stop aws-playground-elasticmq')),
    'the pending timer should have been cancelled by the sweep');
});

// The UI polls /api/services every few seconds. One `docker ps -a` answers
// both "is docker up?" and "what is every container doing?", so the poll
// costs one process spawn instead of `docker info` plus one `docker
// inspect` per registered service.
test('list reads every service state from a single docker call', async () => {
  scenario({ ps: { code: 0, stdout:
    'aws-playground-minio running\naws-playground-redis exited' } });

  const listed = (await services.list()).services;

  const state = (n) => listed.find(s => s.name === n).state;
  assert.strictEqual(state('minio'), 'running');
  assert.strictEqual(state('redis'), 'stopped');
  assert.strictEqual(state('postgres'), 'absent');
  assert.strictEqual(calls().length, 1, 'the whole list should cost one docker call');
});

test('list reports docker unavailable when the daemon is down', async () => {
  scenario({ ps: { code: 1, stdout: 'Cannot connect to the Docker daemon' } });

  const { docker, services: listed } = await services.list();

  assert.strictEqual(docker.available, false);
  assert.ok(listed.every(s => s.state === 'unavailable'));
});

test('list includes per-service credentials', async () => {
  scenario({ ps: { code: 0, stdout: '' } });
  const listed = (await services.list()).services;
  function creds(name) {
    return listed.find(s => s.name === name).credentials;
  }
  assert.deepStrictEqual(creds('minio'), [
    { label: 'Access key', value: 'playground' },
    { label: 'Secret key', value: 'playground123' },
  ]);
  assert.deepStrictEqual(creds('elasticmq'), [
    { label: 'Access key', value: 'playground' },
    { label: 'Secret key', value: 'playground123' },
  ]);
  assert.deepStrictEqual(creds('dynamodb'), [
    { label: 'Access key', value: 'playground' },
    { label: 'Secret key', value: 'playground123' },
  ]);
  assert.deepStrictEqual(creds('postgres'), [
    { label: 'User', value: 'playground' },
    { label: 'Password', value: 'playground123' },
    { label: 'Database', value: 'playground' },
  ]);
  assert.deepStrictEqual(creds('redis'), []);
});
