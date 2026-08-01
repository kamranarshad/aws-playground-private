const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findFixturePackages } = require('../scripts/install-fixtures');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

test('finds every fixture that declares dependencies', () => {
  const found = findFixturePackages(FIXTURES).map((dir) => path.relative(FIXTURES, dir));
  for (const name of ['apigw', 'node-s3', 'winston-datadog']) {
    assert.ok(found.includes(path.join('typescript', name)), `missing typescript/${name}`);
  }
  // Deliberately not an exact list: adding a fixture should not break this
  // test, but every hit does have to be a real package.
  for (const rel of found) {
    assert.ok(fs.existsSync(path.join(FIXTURES, rel, 'package.json')), `${rel} has no package.json`);
  }
});

test('ignores installed dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fixtures-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'package.json'), '{}');
  assert.deepStrictEqual(findFixturePackages(dir), []);
});

test('does not descend into a fixture that is itself a package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fixtures-'));
  fs.mkdirSync(path.join(dir, 'demo', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo', 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'demo', 'nested', 'package.json'), '{}');
  assert.deepStrictEqual(findFixturePackages(dir), [path.join(dir, 'demo')]);
});
