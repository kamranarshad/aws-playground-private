const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('cli starts server, prints URL, serves health, and shuts down', async () => {
  const child = spawn(process.execPath, [CLI, '--port', '0', '--no-open'], {
    env: { ...process.env,
      AWS_PLAYGROUND_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-')) },
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('no URL printed. output: ' + out)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening at (http:\/\/localhost:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  const res = await fetch(url + '/api/health');
  assert.strictEqual(res.status, 200);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));
});

test('cli --help prints usage and exits 0', async () => {
  const child = spawn(process.execPath, [CLI, '--help']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0);
  assert.ok(out.includes('--port'));
  assert.ok(out.includes('--no-open'));
});
