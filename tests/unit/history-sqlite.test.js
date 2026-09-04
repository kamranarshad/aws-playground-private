const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-histsql-'));
const history = require('../../server/persistence/history');

function entry(overrides = {}) {
  return {
    handler: 'index.handler',
    event: { hello: 'world' },
    response: { statusCode: 200 },
    error: null,
    logs: 'test log\n',
    report: { requestId: 'req-' + Math.random().toString(36).slice(2), durationMs: 10 },
    durationMs: 10,
    ok: true,
    ...overrides,
  };
}

test('history pagination supports limit and offset', () => {
  for (let i = 1; i <= 10; i++) {
    history.append('fn-page', entry({ durationMs: i * 10, logs: `log-${i}` }));
  }

  const page1 = history.list('fn-page', { limit: 3, offset: 0 });
  assert.strictEqual(page1.length, 3);
  assert.strictEqual(page1[0].logs, 'log-10');
  assert.strictEqual(page1[1].logs, 'log-9');
  assert.strictEqual(page1[2].logs, 'log-8');

  const page2 = history.list('fn-page', { limit: 3, offset: 3 });
  assert.strictEqual(page2.length, 3);
  assert.strictEqual(page2[0].logs, 'log-7');
  assert.strictEqual(page2[1].logs, 'log-6');
  assert.strictEqual(page2[2].logs, 'log-5');
});

test('getByRequestId finds entry directly in SQLite', () => {
  const reqId = 'req-sqlite-unique-123';
  history.append('fn-req', entry({ report: { requestId: reqId, durationMs: 42 } }));

  const found = history.getByRequestId('fn-req', reqId);
  assert.ok(found);
  assert.strictEqual(found.report.requestId, reqId);
  assert.strictEqual(found.report.durationMs, 42);

  const missing = history.getByRequestId('fn-req', 'non-existent');
  assert.strictEqual(missing, null);
});

test('getStats calculates aggregation and percentiles correctly', () => {
  // Empty function stats
  const empty = history.getStats('fn-empty');
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.successes, 0);
  assert.strictEqual(empty.failures, 0);
  assert.strictEqual(empty.errorRate, 0);

  // Append a set of known durations and success/failure outcomes
  const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (let i = 0; i < durations.length; i++) {
    const isError = i === 9; // 1 out of 10 is failure
    history.append('fn-stats', entry({
      durationMs: durations[i],
      ok: !isError,
      error: isError ? { type: 'Runtime.HandlerError', message: 'crash' } : null,
    }));
  }

  const stats = history.getStats('fn-stats');
  assert.strictEqual(stats.total, 10);
  assert.strictEqual(stats.successes, 9);
  assert.strictEqual(stats.failures, 1);
  assert.strictEqual(stats.errorRate, 0.1);
  assert.strictEqual(stats.avgDurationMs, 55);
  assert.strictEqual(stats.minDurationMs, 10);
  assert.strictEqual(stats.maxDurationMs, 100);
  assert.strictEqual(stats.p50DurationMs, 60);
  assert.strictEqual(stats.p95DurationMs, 100);
});
