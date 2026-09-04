const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planPrepare } = require('../../scripts/prepare');

const ROOT = path.join(__dirname, '..', '..');

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

// Proves the script is wired to the planner: with the skip flag it must
// return immediately and silently rather than spending a minute on vite.
test('running the script with the skip flag exits 0 and stays quiet', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare.js')], {
    env: { ...process.env, AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(out.trim(), '');
});
