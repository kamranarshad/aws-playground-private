const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planPrepare, packageManagerBin } = require('../scripts/prepare');

const ROOT = path.join(__dirname, '..');

// A stand-in package root. `withWeb` is the difference between a source
// checkout and an unpacked tarball, which ships web/dist but no web/ source.
function fakeRoot(withWeb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-prepare-'));
  if (withWeb) {
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'package.json'), '{}');
  }
  return dir;
}

test('a source checkout installs with npm install', () => {
  assert.deepStrictEqual(planPrepare({ root: fakeRoot(true), env: {} }),
    { install: 'install' });
});

test('CI installs from the lockfile instead', () => {
  assert.deepStrictEqual(planPrepare({ root: fakeRoot(true), env: { CI: 'true' } }),
    { install: 'ci' });
});

test('a packed tarball has no web/ source, so there is nothing to build', () => {
  const plan = planPrepare({ root: fakeRoot(false), env: {} });
  assert.ok(plan.skip, 'should report why it skipped');
  assert.ok(!plan.install, 'should not install anything');
});

test('AWS_PLAYGROUND_SKIP_WEB_BUILD skips even in a full checkout', () => {
  const plan = planPrepare({
    root: fakeRoot(true), env: { AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
  });
  assert.ok(plan.skip, 'should report why it skipped');
  assert.ok(!plan.install, 'should not install anything');
});

test('an install driven by nub keeps using nub for web/', () => {
  assert.strictEqual(packageManagerBin({
    npm_config_user_agent: 'nub/0.7.1 npm/? node/v23.8.0 darwin arm64',
  }), 'nub');
});

test('npm installs (and unknown agents) stay on npm', () => {
  assert.strictEqual(packageManagerBin({
    npm_config_user_agent: 'npm/10.9.2 node/v22.12.0 workspaces/false',
  }), 'npm');
  assert.strictEqual(packageManagerBin({}), 'npm');
});

// Proves the script is wired to the planner: with the skip flag it must
// return immediately and silently rather than spending a minute on vite.
test('running the script with the skip flag exits 0 and stays quiet', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare.js')], {
    env: { ...process.env, AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(out.trim(), '');
});
