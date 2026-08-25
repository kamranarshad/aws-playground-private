const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { read } = require('../server/projectconfig');

function proj(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pc-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'playground.json'), content);
  return dir;
}

test('valid services list is returned', () => {
  const dir = proj(JSON.stringify({ services: ['minio', 'elasticmq'] }));
  assert.deepStrictEqual(read(dir), { services: ['minio', 'elasticmq'], trigger: null });
});

test('unknown service names are filtered out', () => {
  const dir = proj(JSON.stringify({ services: ['minio', 'fakeservice', 'redis'] }));
  assert.deepStrictEqual(read(dir), { services: ['minio', 'redis'], trigger: null });
});

test('missing file, invalid JSON, and non-array services yield null', () => {
  assert.deepStrictEqual(read(proj()), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj('{not json')), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ services: 'minio' }))), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ other: 1 }))), { services: null, trigger: null });
});

test('valid sqs trigger is returned with enabled stamped true', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs', queueName: 'my-queue' } }));
  assert.deepStrictEqual(read(dir),
    { services: null, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } });
});

test('a playground.json sqs queueName is trimmed before being stored', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs', queueName: '  my-queue  ' } }));
  assert.deepStrictEqual(read(dir), { services: null, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } });
});

test('valid http trigger is returned with enabled stamped true', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'http' } }));
  assert.deepStrictEqual(read(dir), { services: null, trigger: { type: 'http', enabled: true } });
});

test('sqs trigger without a queueName is rejected', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs' } }));
  assert.deepStrictEqual(read(dir), { services: null, trigger: null });
});

test('unknown trigger type, missing trigger, and non-object trigger all yield null', () => {
  assert.deepStrictEqual(read(proj(JSON.stringify({ trigger: { type: 'sns' } }))),
    { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ other: 1 }))), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ trigger: 'http' }))), { services: null, trigger: null });
});

test('services and trigger are both read independently from the same file', () => {
  const dir = proj(JSON.stringify({ services: ['minio'], trigger: { type: 'http' } }));
  assert.deepStrictEqual(read(dir), { services: ['minio'], trigger: { type: 'http', enabled: true } });
});
