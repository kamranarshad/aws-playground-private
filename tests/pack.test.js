const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const built = fs.existsSync(path.join(ROOT, 'web', 'dist', 'server', 'server.js'));

test('packed tarball boots and serves the API',
  { skip: built ? false : 'web/dist missing - run npm run build first' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pack-'));
  // `npm pack` runs the prepare script; this test already required a current
  // web/dist to run at all, so rebuilding it here would just cost a minute.
  const tarball = execFileSync('npm', ['pack', '--pack-destination', work], {
    cwd: ROOT,
    env: { ...process.env, AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
  }).toString().trim().split('\n').pop();
  execFileSync('tar', ['xzf', path.join(work, tarball)], { cwd: work });
  const pkgDir = path.join(work, 'package');
  const child = spawn(process.execPath, [path.join(pkgDir, 'bin', 'cli.js'), '--no-open', '--port', '0'], {
    cwd: pkgDir,
    env: { ...process.env, AWS_PLAYGROUND_DATA_DIR: path.join(work, 'data') },
  });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line; output: ${out}`)), 30000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/listening at http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)); });
    });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(health.status, 200);
    assert.ok('runtimes' in await health.json());
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});
