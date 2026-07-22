const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

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
