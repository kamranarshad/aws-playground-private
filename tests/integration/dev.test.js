const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', 'web');
// Vite hoists to the root node_modules under workspaces, so probe by
// resolution rather than by a fixed path.
const hasDeps = (() => {
  try { require.resolve('vite', { paths: [WEB] }); return true; } catch { return false; }
})();

test('vite dev server serves the app shell and the API',
  { skip: hasDeps ? false : 'web/node_modules missing - run npm --prefix web install first' },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-dev-'));
    // NO_COLOR: on CI, color libs emit ANSI even without a TTY (the runner
    // renders it), which used to break the banner regex below.
    const child = spawn('npm', ['--prefix', WEB, 'run', 'dev', '--', '--port', '4780'], {
      env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: dataDir, NO_COLOR: '1' },
      detached: true,
    });
    let out = '';
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() =>
          reject(new Error(`vite did not report a port; output:\n${out}`)), 30000);
        const onData = (d) => {
          out += d;
          // Strip ANSI escapes before matching, in case color sneaks through
          // NO_COLOR (e.g. a lib that only honors FORCE_COLOR).
          // eslint-disable-next-line no-control-regex -- \x1b is the ANSI escape itself, not a mistake
          const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
          const m = plain.match(/Local:\s+http:\/\/localhost:(\d+)\//);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`dev server exited ${code}: ${out}`));
        });
      });

      const health = await fetch(`http://localhost:${port}/api/health`);
      assert.strictEqual(health.status, 200,
        `expected 200 from /api/health, got ${health.status}`);
      const body = await health.json();
      assert.ok(body.runtimes.node.available);

      // Trigger resumption and the S3 listener used to live only in
      // bin/cli.js, so the dev server served a UI whose triggers never
      // fired. This is the parity check.
      const triggers = await fetch(`http://localhost:${port}/api/triggers`);
      assert.strictEqual(triggers.status, 200,
        `expected 200 from /api/triggers, got ${triggers.status}`);

      const home = await fetch(`http://localhost:${port}/`);
      assert.strictEqual(home.status, 200,
        `expected 200 from /, got ${home.status}`);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
