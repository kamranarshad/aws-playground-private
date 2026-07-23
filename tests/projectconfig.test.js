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
  assert.deepStrictEqual(read(dir), { services: ['minio', 'elasticmq'] });
});

test('unknown service names are filtered out', () => {
  const dir = proj(JSON.stringify({ services: ['minio', 'fakeservice', 'redis'] }));
  assert.deepStrictEqual(read(dir), { services: ['minio', 'redis'] });
});

test('missing file, invalid JSON, and non-array services yield null', () => {
  assert.deepStrictEqual(read(proj()), { services: null });
  assert.deepStrictEqual(read(proj('{not json')), { services: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ services: 'minio' }))), { services: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ other: 1 }))), { services: null });
});
