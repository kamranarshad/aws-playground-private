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

test('dockerAvailable reflects docker info', async () => {
  scenario({ info: { code: 0, stdout: 'ok' } });
  assert.strictEqual(await services.dockerAvailable(), true);
  scenario({ info: { code: 1, stdout: '' } });
  assert.strictEqual(await services.dockerAvailable(), false);
});

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
  scenario({ info: { code: 0, stdout: 'ok' }, inspect: { code: 0, stdout: 'true' } });
  const r = await services.list();
  assert.strictEqual(r.docker.available, true);
  const minio = r.services.find(s => s.name === 'minio');
  assert.strictEqual(minio.label, 'S3 (MinIO)');
  assert.strictEqual(minio.state, 'running');
  assert.strictEqual(minio.endpoint, 'http://127.0.0.1:9400');
  assert.strictEqual(minio.consoleUrl, 'http://127.0.0.1:9401');
});

test('envFor returns injectable env for a service', () => {
  const env = services.envFor('minio');
  assert.strictEqual(env.AWS_ENDPOINT_URL, 'http://127.0.0.1:9400');
  assert.strictEqual(env.AWS_ENDPOINT_URL_S3, 'http://127.0.0.1:9400');
  assert.strictEqual(env.AWS_ACCESS_KEY_ID, 'playground');
  assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, 'playground123');
});
