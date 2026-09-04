const { test } = require('node:test');
const assert = require('node:assert');
const inFlight = require('../../server/api/in-flight');

test('inFlight allows single invoke and reports has correctly', () => {
  assert.strictEqual(inFlight.has('fn-q1'), false);
  inFlight.add('fn-q1');
  assert.strictEqual(inFlight.has('fn-q1'), true);
  inFlight.delete('fn-q1');
  assert.strictEqual(inFlight.has('fn-q1'), false);
});

test('waitFor resolves immediately if function is not in flight', async () => {
  const ok = await inFlight.waitFor('not-in-flight', 500);
  assert.strictEqual(ok, true);
});

test('waitFor waits for current invoke to complete before resolving', async () => {
  inFlight.add('fn-q2');
  let waited = false;
  const promise = inFlight.waitFor('fn-q2', 2000).then((res) => {
    waited = true;
    return res;
  });

  // Not resolved yet while fn-q2 is in flight
  assert.strictEqual(waited, false);

  // Complete invoke
  inFlight.delete('fn-q2');
  const ok = await promise;
  assert.strictEqual(ok, true);
  assert.strictEqual(waited, true);
});

test('waitFor times out if invoke takes longer than timeout', async () => {
  inFlight.add('fn-q3');
  const ok = await inFlight.waitFor('fn-q3', 50);
  assert.strictEqual(ok, false);
  inFlight.delete('fn-q3');
});
