const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real-docker E2E, opt-in by environment: runs only when the docker daemon
// responds AND the service's image is already present locally (never pulls).
function imagePresent(image) {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const daemonUp = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();

delete process.env.AWS_PLAYGROUND_DOCKER; // real docker, not a shim
const services = require('../server/services');

for (const [name, image] of [
  ['minio', 'minio/minio'],
  ['elasticmq', 'softwaremill/elasticmq-native'],
  ['dynamodb', 'amazon/dynamodb-local'],
  ['redis', 'redis:alpine'],
  ['postgres', 'postgres:alpine'],
]) {
  const ready = daemonUp && imagePresent(image);
  test(`${name} container starts, becomes ready, and stops`,
    { skip: ready ? false : `docker daemon or ${image} image not available` }, async () => {
    const started = await services.start(name);
    assert.strictEqual(started.ok, true, started.output);
    assert.strictEqual(await services.status(name), 'running');
    const stopped = await services.stop(name);
    assert.strictEqual(stopped.ok, true, stopped.output);
    assert.strictEqual(await services.status(name), 'stopped');
  });
}

// End-to-end: the ts-node-s3 fixture reads/writes real MinIO through the API.
const s3Ready = daemonUp && imagePresent('minio/minio')
  && fs.existsSync(path.join(__dirname, '..', 'fixtures', 'ts-node-s3', 'dist', 'index.js'));

test('ts-node-s3 fixture round-trips an object through real MinIO',
  { skip: s3Ready ? false : 'docker/minio image/fixture build not available' }, async () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-s3e2e-'));
  const api = require('../server/api');
  // Defend against a leftover container from a prior interrupted run wedging
  // `docker run --name` (name-in-use). Best-effort; ignore if absent.
  try { execFileSync('docker', ['rm', '-f', 'aws-playground-minio'], { stdio: 'ignore', timeout: 15000 }); } catch {}
  const started = await services.start('minio');
  assert.strictEqual(started.ok, true, started.output);
  try {
    const created = api.createFunction({ name: 's3fn',
      path: path.join(__dirname, '..', 'fixtures', 'ts-node-s3'),
      runtime: 'node', handler: 'dist/index.handler' });
    const key = `e2e-${Date.now()}.txt`;
    const put = await api.invokeFunction({ functionId: created.body.id,
      event: { action: 'put', key, body: 'real minio' } });
    assert.strictEqual(put.body.ok, true, JSON.stringify(put.body));
    assert.strictEqual(put.body.response.action, 'put');

    const get = await api.invokeFunction({ functionId: created.body.id,
      event: { action: 'get', key } });
    assert.strictEqual(get.body.response.body, 'real minio');

    const miss = await api.invokeFunction({ functionId: created.body.id,
      event: { action: 'get', key: 'does-not-exist' } });
    assert.strictEqual(miss.body.response.error, 'NoSuchKey');
  } finally {
    await services.stop('minio');
  }
});
