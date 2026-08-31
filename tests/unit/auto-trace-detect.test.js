const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasOwnTracingSetup } = require('../../server/trace/auto-trace-detect');

function projectWith(pkgJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-autotrace-'));
  if (pkgJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson));
  }
  return dir;
}

test('true when @opentelemetry/sdk-trace-node is a direct dependency', () => {
  const dir = projectWith({ dependencies: { '@opentelemetry/sdk-trace-node': '^2.0.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('true when the sdk-trace package is only a devDependency', () => {
  const dir = projectWith({ devDependencies: { '@opentelemetry/sdk-trace': '^2.0.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('false when only @opentelemetry/api is present -- the API alone configures nothing', () => {
  const dir = projectWith({ dependencies: { '@opentelemetry/api': '^1.9.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json has no dependencies at all', () => {
  const dir = projectWith({ name: 'x' });
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json is missing', () => {
  const dir = projectWith(undefined);
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json is malformed JSON', () => {
  const dir = projectWith(undefined);
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('real fixture: otel-span declares its own tracing and is correctly detected', () => {
  const dir = path.join(__dirname, '..', '..', 'fixtures', 'typescript', 'otel-span');
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('true when @opentelemetry/sdk-node is a direct dependency', () => {
  const dir = projectWith({ dependencies: { '@opentelemetry/sdk-node': '^0.55.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('true when @opentelemetry/sdk-node is only a devDependency', () => {
  const dir = projectWith({ devDependencies: { '@opentelemetry/sdk-node': '^0.55.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});
