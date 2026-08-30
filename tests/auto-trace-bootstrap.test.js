const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BOOTSTRAP = path.join(__dirname, '..', 'harnesses', 'node', 'auto-trace-bootstrap.cjs');

test('loading the bootstrap does not throw and defines the flush hook', () => {
  const output = execFileSync(process.execPath,
    ['--require', BOOTSTRAP, '-e', 'console.log(typeof globalThis.__awsPlaygroundFlushTracing)'],
    { encoding: 'utf8' });
  assert.strictEqual(output.trim(), 'function');
});
