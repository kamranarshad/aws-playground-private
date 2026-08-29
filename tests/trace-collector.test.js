const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-tc-'));
const history = require('../server/history');
const traceCollector = require('../server/trace-collector');

beforeEach(() => {
  process.env.AWS_PLAYGROUND_TRACE_WINDOW_MS = '50';
});

test('spans ingested before the window starts are included in the snapshot', () => {
  traceCollector.open('req-1', 'fn-a');
  traceCollector.ingest('req-1', [{ name: 'span-a' }]);
  const { spans } = traceCollector.snapshotAndStartWindow('req-1');
  assert.deepStrictEqual(spans, [{ name: 'span-a' }]);
});

test('ingest for an unknown requestId is dropped silently', () => {
  assert.doesNotThrow(() => traceCollector.ingest('never-opened', [{ name: 'x' }]));
});

test('spans ingested during the post-exit window are persisted to history', async () => {
  history.append('fn-b', { report: { requestId: 'req-2', durationMs: 1 }, ok: true, logs: '' });
  traceCollector.open('req-2', 'fn-b');
  traceCollector.snapshotAndStartWindow('req-2');
  traceCollector.ingest('req-2', [{ name: 'late-span' }]);
  const found = history.getByRequestId('fn-b', 'req-2');
  assert.deepStrictEqual(found.trace.spans, [{ name: 'late-span' }]);
  assert.strictEqual(found.trace.pending, true);
});

test('the window closes after windowMs, drops the buffer, and marks history not pending', async () => {
  history.append('fn-c', { report: { requestId: 'req-3', durationMs: 1 }, ok: true, logs: '' });
  traceCollector.open('req-3', 'fn-c');
  traceCollector.snapshotAndStartWindow('req-3');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const found = history.getByRequestId('fn-c', 'req-3');
  assert.strictEqual(found.trace.pending, false);
  // a straggler after close is dropped, not reopening the window
  traceCollector.ingest('req-3', [{ name: 'too-late' }]);
  assert.strictEqual(history.getByRequestId('fn-c', 'req-3').trace.spans.length, 0);
});
