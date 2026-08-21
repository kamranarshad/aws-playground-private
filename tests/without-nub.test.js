const { test } = require('node:test');
const assert = require('node:assert');
const { delimiter } = require('node:path');
const { withoutNub } = require('../scripts/without-nub');

test('strips the nub node shim from PATH and its preload from NODE_OPTIONS', () => {
  const env = withoutNub({
    PATH: ['/usr/bin', '/tmp/nub-node-shim-123-abc', '/opt/homebrew/bin'].join(delimiter),
    NODE_OPTIONS: '--enable-source-maps --require=/Users/x/.cache/nub/runtime-0.7.1-d8c1f9ba/preload.cjs',
  });
  assert.strictEqual(env.PATH, ['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
  assert.strictEqual(env.NODE_OPTIONS, '--enable-source-maps');
});

test('drops NODE_OPTIONS entirely when nub was its only content', () => {
  const env = withoutNub({
    NODE_OPTIONS: '--require=/Users/x/.cache/nub/runtime-0.7.1-d8c1f9ba/preload.cjs',
  });
  assert.ok(!('NODE_OPTIONS' in env));
});

// The common case: no nub anywhere. A contributor on plain npm must get
// their environment back byte-for-byte.
test('is a pass-through for an environment without nub', () => {
  const before = {
    PATH: ['/usr/bin', '/usr/local/bin'].join(delimiter),
    NODE_OPTIONS: '--max-old-space-size=4096',
    HOME: '/Users/x',
  };
  assert.deepStrictEqual(withoutNub(before), before);
});
