const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cli.js');
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'javascript', 'apigw');

test('cli invoke runs function headlessly and outputs json', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-invoke-'));
  const store = require('../../server/persistence/store');
  process.env.AWS_PLAYGROUND_DATA_DIR = dataDir;

  store.create({
    name: 'smoke-cli',
    path: FIXTURE,
    runtime: 'node',
    handler: 'index.handler',
  });

  const eventFile = path.join(FIXTURE, 'events', 'get-hello.json');
  const res = spawnSync(process.execPath, [
    CLI, 'invoke', 'smoke-cli', '--json', '--event', eventFile,
  ], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `Process failed: ${res.stderr}`);
  const output = JSON.parse(res.stdout);
  assert.strictEqual(output.statusCode, 200);
});

test('cli invoke reports error for unknown function', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-inv-err-'));
  const res = spawnSync(process.execPath, [
    CLI, 'invoke', 'non-existent-function',
  ], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('not found'));
});
