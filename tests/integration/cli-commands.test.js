const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cli.js');
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'javascript', 'apigw');

test('cli list prints registered functions in table and json format', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-list-'));
  const store = require('../../server/persistence/store');
  process.env.AWS_PLAYGROUND_DATA_DIR = dataDir;

  store.create({
    name: 'list-test-fn',
    path: FIXTURE,
    runtime: 'node',
    handler: 'index.handler',
  });

  const resTable = spawnSync(process.execPath, [CLI, 'list'], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.strictEqual(resTable.status, 0);
  assert.ok(resTable.stdout.includes('list-test-fn'));
  assert.ok(resTable.stdout.includes('index.handler'));

  const resJson = spawnSync(process.execPath, [CLI, 'list', '--json'], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.strictEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].name, 'list-test-fn');
});

test('cli services list reports service registry and json format', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-svc-'));
  const res = spawnSync(process.execPath, [CLI, 'services', 'list'], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes('MinIO') || res.stdout.includes('S3'));
  assert.ok(res.stdout.includes('DynamoDB'));

  const resJson = spawnSync(process.execPath, [CLI, 'services', 'list', '--json'], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.strictEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.ok(parsed.services);
  assert.ok(Array.isArray(parsed.services));
});
