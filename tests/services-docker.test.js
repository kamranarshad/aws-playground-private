const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

// Real-docker E2E, opt-in by environment: runs only when the docker daemon
// responds AND the minio image is already present locally (never pulls).
function dockerReady() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
    execFileSync('docker', ['image', 'inspect', 'minio/minio'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const ready = dockerReady();

test('minio container starts, becomes ready, and stops',
  { skip: ready ? false : 'docker daemon or minio/minio image not available' }, async () => {
  delete process.env.AWS_PLAYGROUND_DOCKER; // real docker, not a shim
  const services = require('../server/services');

  const started = await services.start('minio');
  assert.strictEqual(started.ok, true, started.output);
  assert.strictEqual(await services.status('minio'), 'running');

  const health = await fetch('http://127.0.0.1:9400/minio/health/live');
  assert.strictEqual(health.status, 200);

  const stopped = await services.stop('minio');
  assert.strictEqual(stopped.ok, true, stopped.output);
  assert.strictEqual(await services.status('minio'), 'stopped');
});
