const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

// The CLI refuses to boot without a built web app, so on a fresh checkout
// these would fail with an opaque "no URL printed" timeout rather than saying
// what is actually missing. Skip with a reason instead, the same way
// web.test.js does. --help needs no build, so it always runs.
const DIST = path.join(__dirname, '..', 'web', 'dist');
const needsBuild = fs.existsSync(path.join(DIST, 'server', 'server.js'))
  ? false : 'web/dist missing - run npm run build first';

test('cli starts server, prints URL, serves health, and shuts down',
  { skip: needsBuild }, async () => {
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

test('server binds to loopback only, not reachable via a LAN interface',
  { skip: needsBuild }, async () => {
  const ifaces = os.networkInterfaces();
  let lanIp = null;
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) { lanIp = iface.address; break; }
    }
    if (lanIp) break;
  }
  if (!lanIp) return; // no non-loopback IPv4 interface on this machine; nothing to probe

  const child = spawn(process.execPath, [CLI, '--port', '0', '--no-open'], {
    env: { ...process.env,
      AWS_PLAYGROUND_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-lan-')) },
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('no URL printed. output: ' + out)), 5000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/listening at (http:\/\/localhost:(\d+))/);
        if (m) { clearTimeout(timer); resolve(m[2]); }
      });
    });
    const port = url;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2000);
    let reached = false;
    try {
      await fetch(`http://${lanIp}:${port}/api/health`, { signal: controller.signal });
      reached = true;
    } catch {
      reached = false;
    } finally {
      clearTimeout(abortTimer);
    }
    assert.strictEqual(reached, false,
      `server should not be reachable via LAN address ${lanIp}:${port}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
  }
});

// Closing the browser used to leave auto-started containers running: the
// grace timer lives in the server process, which then gets killed. The
// server now sweeps them on the way out.
test('cli stops auto-started services on SIGTERM', { skip: needsBuild }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-sweep-'));
  const projectDir = path.join(tmp, 'project');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(projectDir, 'playground.json'),
    JSON.stringify({ services: ['minio'] }));
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'exports.handler = async () => ({});');
  fs.writeFileSync(path.join(dataDir, 'functions.json'), JSON.stringify({
    functions: [{
      id: 'fn-sweep', name: 'sweep', path: projectDir, runtime: 'node',
      handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
      env: {}, envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
    }],
  }));

  // docker shim: every container looks absent, every other command succeeds.
  const calls = path.join(tmp, 'calls.log');
  const shim = path.join(tmp, 'docker');
  fs.writeFileSync(shim, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
process.exit(process.argv[2] === 'inspect' ? 1 : 0);
`);
  fs.chmodSync(shim, 0o755);

  const child = spawn(process.execPath, [CLI, '--port', '0', '--no-open'], {
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir, AWS_PLAYGROUND_DOCKER: shim },
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('no URL printed. output: ' + out)), 5000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/listening at (http:\/\/localhost:\d+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });
    const res = await fetch(url + '/api/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ functionId: 'fn-sweep', waitReady: false }),
    });
    assert.deepStrictEqual((await res.json()).started, ['minio']);

    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(code, 0, 'server should shut down cleanly');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  assert.ok(fs.readFileSync(calls, 'utf8').includes('stop aws-playground-minio'),
    'the auto-started container should be stopped on shutdown');
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
