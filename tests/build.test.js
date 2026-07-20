const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runBuild } = require('../server/build');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-build-'));
}

test('successful build captures output and duration', async () => {
  const dir = tmpDir();
  const r = await runBuild({ dir,
    command: `node -e "console.log('compiling'); console.error('warn line')"` });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.exitCode, 0);
  assert.ok(r.output.includes('compiling'));
  assert.ok(r.output.includes('warn line'));
  assert.ok(r.durationMs >= 0);
});

test('build runs in the project directory', async () => {
  const dir = tmpDir();
  const r = await runBuild({ dir, command: 'node -e "console.log(process.cwd())"' });
  assert.ok(r.ok);
  assert.ok(r.output.includes(fs.realpathSync(dir)));
});

test('failing build reports exit code and output', async () => {
  const dir = tmpDir();
  const r = await runBuild({ dir,
    command: `node -e "console.error('boom: type error TS2322'); process.exit(2)"` });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 2);
  assert.ok(r.output.includes('boom: type error TS2322'));
});

test('build timeout kills the process and fails', async () => {
  const dir = tmpDir();
  const r = await runBuild({ dir, timeoutMs: 500,
    command: 'node -e "setTimeout(() => {}, 60000)"' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.output.includes('timed out'));
});

test('unrunnable command fails gracefully', async () => {
  const dir = tmpDir();
  const r = await runBuild({ dir, command: 'definitely-not-a-real-command-xyz' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.output.length > 0);
});
