const { test } = require('node:test');
const assert = require('node:assert');
const { PORTS } = require('../../server/ports');
const { REGISTRY } = require('../../server/services/registry');

test('every port is a distinct loopback port number', () => {
  const values = Object.values(PORTS);
  assert.ok(values.every((p) => Number.isInteger(p) && p > 1024 && p < 65536));
  assert.strictEqual(new Set(values).size, values.length, 'duplicate port assignment');
});

test('PORTS is frozen so nothing can reassign a port at runtime', () => {
  // CommonJS modules are non-strict, so an assignment to a frozen object
  // silently no-ops rather than throwing -- assert the value, not a throw.
  PORTS.httpTrigger = 1;
  assert.strictEqual(PORTS.httpTrigger, 9500);
});

test('the service registry composes its ports from PORTS, not literals', () => {
  assert.strictEqual(REGISTRY.minio.endpoint, `http://127.0.0.1:${PORTS.minio}`);
  assert.strictEqual(REGISTRY.minio.consoleUrl, `http://127.0.0.1:${PORTS.minioConsole}`);
  assert.strictEqual(REGISTRY.dynamodb.endpoint, `http://127.0.0.1:${PORTS.dynamodb}`);
  assert.strictEqual(REGISTRY.redis.endpoint, `redis://127.0.0.1:${PORTS.redis}`);
  assert.strictEqual(REGISTRY.postgres.endpoint, `postgresql://127.0.0.1:${PORTS.postgres}`);
  assert.strictEqual(REGISTRY.elasticmq.endpoint, `http://127.0.0.1:${PORTS.elasticmq}`);
  assert.strictEqual(REGISTRY.elasticmq.consoleUrl, `http://127.0.0.1:${PORTS.elasticmqConsole}`);
});

test("MinIO's webhook endpoint tracks the S3 trigger listener's port", () => {
  const webhook = REGISTRY.minio.runArgs.find((a) => String(a).includes('MINIO_NOTIFY_WEBHOOK_ENDPOINT'));
  assert.ok(webhook.endsWith(`:${PORTS.s3Webhook}/`),
    `expected the webhook arg to use PORTS.s3Webhook, got ${webhook}`);
});
