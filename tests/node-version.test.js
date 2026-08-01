const { test } = require('node:test');
const assert = require('node:assert');
const { MIN_NODE, nodeVersionOk, nodeVersionMessage } = require('../server/node-version');

test('the floor matches what package.json declares', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.engines.node, `>=${MIN_NODE}`);
});

test('nodeVersionOk accepts the floor and anything above it', () => {
  assert.strictEqual(nodeVersionOk('v22.12.0'), true);
  assert.strictEqual(nodeVersionOk('v22.20.1'), true);
  assert.strictEqual(nodeVersionOk('v24.0.0'), true);
  assert.strictEqual(nodeVersionOk('22.12.0'), true, 'the leading v is optional');
});

test('nodeVersionOk rejects anything below the floor', () => {
  assert.strictEqual(nodeVersionOk('v20.11.0'), false);
  assert.strictEqual(nodeVersionOk('v22.11.0'), false, 'minor below the floor');
  assert.strictEqual(nodeVersionOk('v22.11.9'), false);
});

test('nodeVersionOk treats an unparseable version as unsupported', () => {
  assert.strictEqual(nodeVersionOk('banana'), false);
  assert.strictEqual(nodeVersionOk(''), false);
});

test('nodeVersionMessage names both the floor and what is installed', () => {
  const msg = nodeVersionMessage('v20.11.0');
  assert.ok(msg.includes(MIN_NODE), 'should name the required version');
  assert.ok(msg.includes('v20.11.0'), 'should name the installed version');
});
