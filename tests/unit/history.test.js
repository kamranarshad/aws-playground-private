const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-hist-'));
const history = require('../../server/persistence/history');

function entry(overrides = {}) {
  return { handler: 'app.handler', event: { a: 1 }, response: { ok: 1 },
    error: null, logs: 'line\n', report: { requestId: 'r', durationMs: 5 },
    durationMs: 5, ok: true, ...overrides };
}

test('append and list round-trip, newest first', () => {
  history.append('fn1', entry({ logs: 'first' }));
  history.append('fn1', entry({ logs: 'second' }));
  const entries = history.list('fn1');
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].logs, 'second');
  assert.strictEqual(entries[1].logs, 'first');
  assert.ok(entries[0].id);
  assert.ok(entries[0].ts > 0);
  assert.strictEqual(entries[0].ok, true);
  assert.deepStrictEqual(entries[0].event, { a: 1 });
});

test('list of unknown function is empty', () => {
  assert.deepStrictEqual(history.list('nope'), []);
});

// MAX_ENTRIES is the default page size: a function with more retained runs
// than that still answers a bare list() with the newest MAX_ENTRIES.
test('list returns the newest MAX_ENTRIES by default', () => {
  for (let i = 0; i < history.MAX_ENTRIES + 7; i++) {
    history.append('fn2', entry({ logs: `run-${i}` }));
  }
  const entries = history.list('fn2');
  assert.strictEqual(entries.length, history.MAX_ENTRIES);
  assert.strictEqual(entries[0].logs, `run-${history.MAX_ENTRIES + 6}`);
  assert.strictEqual(entries[entries.length - 1].logs, 'run-7');
});

test('oversized fields are truncated and flagged', () => {
  const big = 'x'.repeat(history.MAX_FIELD_BYTES + 1000);
  const stored = history.append('fn3', entry({ logs: big, event: { blob: big } }));
  assert.strictEqual(stored.truncated, true);
  assert.strictEqual(stored.eventTruncated, true);
  assert.strictEqual(stored.responseTruncated, false);
  assert.ok(Buffer.byteLength(stored.logs, 'utf8') <= history.MAX_FIELD_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.event), 'utf8') <= history.MAX_FIELD_BYTES + 16);
  const listed = history.list('fn3')[0];
  assert.strictEqual(listed.truncated, true);
  assert.strictEqual(listed.eventTruncated, true);
  assert.strictEqual(listed.responseTruncated, false);
});

test('small entries are not flagged truncated', () => {
  const stored = history.append('fn4', entry());
  assert.strictEqual(stored.truncated, false);
  assert.strictEqual(stored.eventTruncated, false);
  assert.strictEqual(stored.responseTruncated, false);
});

test('append defaults source to manual and preserves an explicit trigger source', () => {
  const manual = history.append('fn11', entry());
  assert.deepStrictEqual(manual.source, { type: 'manual' });
  const triggered = history.append('fn11', entry({ source: { type: 'trigger', messageId: 'm1' } }));
  assert.deepStrictEqual(triggered.source, { type: 'trigger', messageId: 'm1' });
  const listed = history.list('fn11');
  assert.deepStrictEqual(listed[0].source, { type: 'trigger', messageId: 'm1' });
});

// Regression: the entry-wide `truncated` flag used to be the only signal the
// web UI had, so a small response next to oversized logs got mis-rendered as
// if the response itself were a truncated raw string.
test('per-field truncation is independent of other oversized fields', () => {
  const big = 'x'.repeat(history.MAX_FIELD_BYTES + 1000);
  const stored = history.append('fn10', entry({ logs: big, response: { ok: 1 } }));
  assert.strictEqual(stored.truncated, true, 'entry-wide flag still reflects the big logs field');
  assert.strictEqual(stored.responseTruncated, false, 'the small response was not itself truncated');
  assert.deepStrictEqual(stored.response, { ok: 1 });
});

test('clear removes the stored runs', () => {
  history.append('fn5', entry());
  assert.strictEqual(history.clear('fn5'), true);
  assert.deepStrictEqual(history.list('fn5'), []);
  assert.strictEqual(history.clear('fn5'), false);
});

test('truncation never exceeds the cap on multi-byte input', () => {
  const multiByteStr = 'é'.repeat(history.MAX_FIELD_BYTES);
  const stored = history.append('fn6', entry({ logs: multiByteStr }));
  assert.strictEqual(stored.truncated, true);
  const logsByteLength = Buffer.byteLength(stored.logs, 'utf8');
  assert.ok(logsByteLength <= history.MAX_FIELD_BYTES,
    `logs byte length (${logsByteLength}) exceeds MAX_FIELD_BYTES (${history.MAX_FIELD_BYTES})`);
});

test('oversized report is capped and flagged', () => {
  const stored = history.append('fn7', entry({
    report: { requestId: 'r', blob: 'x'.repeat(history.MAX_FIELD_BYTES + 1000) }
  }));
  assert.strictEqual(stored.truncated, true);
  const reportByteLength = Buffer.byteLength(JSON.stringify(stored.report), 'utf8');
  assert.ok(reportByteLength <= history.MAX_FIELD_BYTES + 16,
    `report byte length (${reportByteLength}) exceeds MAX_FIELD_BYTES + 16 (${history.MAX_FIELD_BYTES + 16})`);
  const listed = history.list('fn7')[0];
  assert.strictEqual(listed.truncated, true);
  assert.ok(listed.report);
});

test('append persists trace and includes it in truncated flag', () => {
  const stored = history.append('fn12', entry({ trace: { spans: [{ name: 'a' }], pending: true } }));
  assert.deepStrictEqual(stored.trace, { spans: [{ name: 'a' }], pending: true });
  const listed = history.list('fn12')[0];
  assert.deepStrictEqual(listed.trace, { spans: [{ name: 'a' }], pending: true });
});

test('getByRequestId finds an entry by its report.requestId', () => {
  history.append('fn13', entry({ report: { requestId: 'req-find-me', durationMs: 1 } }));
  const found = history.getByRequestId('fn13', 'req-find-me');
  assert.ok(found);
  assert.strictEqual(found.report.requestId, 'req-find-me');
  assert.strictEqual(history.getByRequestId('fn13', 'no-such-id'), null);
  assert.strictEqual(history.getByRequestId('no-such-fn', 'req-find-me'), null);
});

test('appendSpans merges spans into the matching entry and updates pending', () => {
  history.append('fn14', entry({
    report: { requestId: 'req-merge', durationMs: 1 },
    trace: { spans: [{ name: 'first' }], pending: true },
  }));
  history.appendSpans('fn14', 'req-merge', [{ name: 'second' }], true);
  let found = history.getByRequestId('fn14', 'req-merge');
  assert.deepStrictEqual(found.trace.spans, [{ name: 'first' }, { name: 'second' }]);
  assert.strictEqual(found.trace.pending, true);

  history.appendSpans('fn14', 'req-merge', [], false);
  found = history.getByRequestId('fn14', 'req-merge');
  assert.strictEqual(found.trace.pending, false);
  assert.strictEqual(found.trace.spans.length, 2);
});

test('appendSpans no-ops for an unknown functionId, requestId, or falsy functionId', () => {
  assert.doesNotThrow(() => history.appendSpans(undefined, 'req-x', [{ name: 'x' }], true));
  assert.doesNotThrow(() => history.appendSpans('no-such-fn', 'req-x', [{ name: 'x' }], true));
  history.append('fn15', entry({ report: { requestId: 'req-y', durationMs: 1 } }));
  assert.doesNotThrow(() => history.appendSpans('fn15', 'no-such-request', [{ name: 'x' }], true));
  assert.strictEqual(history.getByRequestId('fn15', 'req-y').trace, undefined);
});

// --- retention: one engine, one retained set -------------------------------
// Stats used to aggregate every run ever recorded while list() returned at
// most MAX_ENTRIES, so the two panels described different data and drifted
// further apart the longer the install was used.
test('stats aggregate only the runs retention keeps', () => {
  process.env.AWS_PLAYGROUND_HISTORY_RETAIN = '10';
  try {
    for (let i = 0; i < 25; i++) history.append('retain1', entry({ durationMs: i + 1 }));
    assert.strictEqual(history.getStats('retain1').total, 10);
  } finally {
    delete process.env.AWS_PLAYGROUND_HISTORY_RETAIN;
  }
});

// The JSONL half was trimmed to MAX_ENTRIES while SQLite kept the row, so a
// late span for a run just outside the list window was silently dropped even
// though the run was still retained and still visible via pagination.
test('appendSpans reaches a retained run outside the default list window', () => {
  for (let i = 0; i < history.MAX_ENTRIES + 10; i++) {
    history.append('spans-deep', entry({ report: { requestId: `req-${i}`, durationMs: 1 } }));
  }
  history.list('spans-deep');

  history.appendSpans('spans-deep', 'req-2', [{ name: 'late' }], false);

  const found = history.getByRequestId('spans-deep', 'req-2');
  assert.ok(found, 'the run is still retained');
  assert.deepStrictEqual(found.trace.spans, [{ name: 'late' }]);
  assert.strictEqual(found.trace.pending, false);
});

// Installs that predate the SQLite consolidation keep their runs in
// history/<id>.jsonl. Those must survive the switch, and must be imported
// exactly once -- the legacy file is set aside (not deleted) afterwards, the
// same instinct store.js applies to an unreadable registry.
test('legacy JSONL history is imported once and the file retired', () => {
  const dir = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'history');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, 'legacy1.jsonl');
  fs.writeFileSync(legacy, [
    { id: 'a', ts: 1, logs: 'old-1', ok: true, durationMs: 3, report: { requestId: 'leg-1' } },
    { id: 'b', ts: 2, logs: 'old-2', ok: true, durationMs: 7, report: { requestId: 'leg-2' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const listed = history.list('legacy1');

  assert.strictEqual(listed.length, 2);
  assert.strictEqual(listed[0].logs, 'old-2', 'newest first');
  assert.strictEqual(history.getStats('legacy1').total, 2, 'imported runs count toward stats');
  assert.strictEqual(history.getByRequestId('legacy1', 'leg-1').logs, 'old-1');
  assert.strictEqual(fs.existsSync(legacy), false, 'the legacy file is retired once imported');
  assert.ok(fs.existsSync(legacy + '.imported'), 'it is set aside, not deleted');
});

// Replaces the old JSONL line-count tests: what they were really protecting
// is that stored history stays bounded on the invoke path without a read
// having to happen first, and that trimming keeps the newest runs.
test('append alone bounds stored history, keeping the newest runs', () => {
  process.env.AWS_PLAYGROUND_HISTORY_RETAIN = '20';
  try {
    for (let i = 0; i < 75; i++) history.append('retain2', entry({ logs: `run-${i}` }));

    // No list() in between -- the bound must hold on writes alone.
    const all = history.list('retain2', { limit: 1000 });
    assert.strictEqual(all.length, 20);
    assert.strictEqual(all[0].logs, 'run-74');
    assert.strictEqual(all[all.length - 1].logs, 'run-55');
  } finally {
    delete process.env.AWS_PLAYGROUND_HISTORY_RETAIN;
  }
});

// Replaces the torn-file test: trimming must never leave a retained run
// unreadable or half-written.
test('every retained run stays readable after trimming', () => {
  process.env.AWS_PLAYGROUND_HISTORY_RETAIN = '15';
  try {
    for (let i = 0; i < 60; i++) {
      history.append('retain3', entry({ event: { i }, report: { requestId: `r-${i}`, durationMs: i } }));
    }
    const all = history.list('retain3', { limit: 1000 });
    assert.strictEqual(all.length, 15);
    for (const e of all) {
      assert.ok(e.id, 'entry survived intact');
      assert.strictEqual(typeof e.event.i, 'number');
      assert.ok(history.getByRequestId('retain3', e.report.requestId), 'still addressable by requestId');
    }
  } finally {
    delete process.env.AWS_PLAYGROUND_HISTORY_RETAIN;
  }
});

test('list paginates over the retained set beyond the default window', () => {
  for (let i = 0; i < 120; i++) history.append('paged', entry({ logs: `run-${i}` }));
  const first = history.list('paged');
  assert.strictEqual(first.length, history.MAX_ENTRIES);
  assert.strictEqual(first[0].logs, 'run-119');
  const second = history.list('paged', { limit: history.MAX_ENTRIES, offset: history.MAX_ENTRIES });
  assert.strictEqual(second.length, history.MAX_ENTRIES);
  assert.strictEqual(second[0].logs, 'run-69');
  assert.strictEqual(history.getStats('paged').total, 120, 'stats see the whole retained set');
});

test('retainLimit falls back to the default when the env override is not a number', () => {
  const prev = process.env.AWS_PLAYGROUND_HISTORY_RETAIN;
  process.env.AWS_PLAYGROUND_HISTORY_RETAIN = 'unlimited';
  try {
    assert.strictEqual(history.retainLimit(), history.RETAIN);
    process.env.AWS_PLAYGROUND_HISTORY_RETAIN = '0';
    assert.strictEqual(history.retainLimit(), history.RETAIN);
  } finally {
    if (prev === undefined) delete process.env.AWS_PLAYGROUND_HISTORY_RETAIN;
    else process.env.AWS_PLAYGROUND_HISTORY_RETAIN = prev;
  }
});

test('clearing history also retires an unread legacy file', () => {
  const dir = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy2.jsonl'),
    JSON.stringify({ id: 'z', ts: 1, logs: 'old', ok: true, report: { requestId: 'leg-z' } }) + '\n');

  assert.strictEqual(history.clear('legacy2'), true);
  assert.deepStrictEqual(history.list('legacy2'), [], 'cleared history does not resurrect');
});
