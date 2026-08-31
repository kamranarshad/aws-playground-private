const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-tc-'));
const history = require('../server/persistence/history');
const traceCollector = require('../server/trace/collector');

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

test('the window closes after windowMs and drops the buffer, without touching history', async () => {
  // Seeded the way a real invoke persists it: invoker.js writes
  // trace: { spans, pending: true } into the history entry it appends.
  history.append('fn-c', { report: { requestId: 'req-3', durationMs: 1 }, ok: true, logs: '',
    trace: { spans: [], pending: true } });
  traceCollector.open('req-3', 'fn-c');
  traceCollector.snapshotAndStartWindow('req-3');
  assert.ok(traceCollector.peek('req-3'), 'buffer is live while the window is open');
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The buffer being gone IS the "not pending" signal now -- close() no
  // longer rewrites the whole history file just to flip a stored flag, so
  // the persisted record keeps whatever pending value it was last written
  // with. Deriving pending from this is api/history.js's getInvokeTrace job.
  assert.strictEqual(traceCollector.peek('req-3'), null);
  const found = history.getByRequestId('fn-c', 'req-3');
  assert.strictEqual(found.trace.pending, true, 'close() must not rewrite history');
  // a straggler after close is dropped, not reopening the window
  traceCollector.ingest('req-3', [{ name: 'too-late' }]);
  assert.strictEqual(traceCollector.peek('req-3'), null);
  assert.strictEqual(history.getByRequestId('fn-c', 'req-3').trace.spans.length, 0);
});

test('peek exposes the live buffer while open and nothing once closed or never opened', async () => {
  assert.strictEqual(traceCollector.peek('never-opened-peek'), null);

  traceCollector.open('req-4', 'fn-d');
  traceCollector.ingest('req-4', [{ name: 'span-p' }]);
  assert.deepStrictEqual(traceCollector.peek('req-4').spans, [{ name: 'span-p' }]);
  assert.strictEqual(traceCollector.peek('req-4').functionId, 'fn-d');

  traceCollector.snapshotAndStartWindow('req-4');
  assert.deepStrictEqual(traceCollector.peek('req-4').spans, [{ name: 'span-p' }]);

  traceCollector.close('req-4');
  assert.strictEqual(traceCollector.peek('req-4'), null);
});
