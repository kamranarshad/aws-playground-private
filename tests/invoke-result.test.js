const { test } = require('node:test');
const assert = require('node:assert');
const { failureResult } = require('../server/api/invoke-result');

test('failureResult builds the standard envelope', () => {
  const r = failureResult({ phase: 'build', type: 'Build.Failed', message: 'nope', memoryMb: 256 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'build');
  assert.deepStrictEqual(r.error, { type: 'Build.Failed', message: 'nope', stackTrace: [] });
  assert.strictEqual(r.logs, '');
  assert.strictEqual(r.report.memoryMb, 256);
  assert.strictEqual(r.report.timedOut, false);
  assert.strictEqual(r.report.durationMs, 0);
  assert.strictEqual(r.report.billedMs, 0);
  assert.ok(r.report.requestId, 'every failure still gets a request id');
});

test('failureResult carries logs and extra report fields when given them', () => {
  const r = failureResult({
    phase: 'build', type: 'Build.Failed', message: 'nope',
    memoryMb: 128, logs: 'output here', report: { buildMs: 42 },
  });
  assert.strictEqual(r.logs, 'output here');
  assert.strictEqual(r.report.buildMs, 42);
});

test('each failureResult gets its own request id', () => {
  const a = failureResult({ phase: 'service', type: 'X', message: 'm', memoryMb: 128 });
  const b = failureResult({ phase: 'service', type: 'X', message: 'm', memoryMb: 128 });
  assert.notStrictEqual(a.report.requestId, b.report.requestId);
});
