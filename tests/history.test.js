const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-hist-'));
const history = require('../server/history');

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

test('cap at MAX_ENTRIES, oldest trimmed', () => {
  for (let i = 0; i < history.MAX_ENTRIES + 7; i++) {
    history.append('fn2', entry({ logs: `run-${i}` }));
  }
  const entries = history.list('fn2');
  assert.strictEqual(entries.length, history.MAX_ENTRIES);
  assert.strictEqual(entries[0].logs, `run-${history.MAX_ENTRIES + 6}`);
  assert.strictEqual(entries[entries.length - 1].logs, 'run-7');
});

function historyFile(functionId) {
  return path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'history', `${functionId}.jsonl`);
}

function lineCount(functionId) {
  return fs.readFileSync(historyFile(functionId), 'utf8').trim().split('\n').length;
}

// Invoking is the hot path: it should cost one appended line, not a full
// read-parse-rewrite of every retained run. Trimming moves to the read side,
// where the entries are already parsed.
test('append only appends; list trims to the cap and compacts', () => {
  for (let i = 0; i < history.MAX_ENTRIES + 5; i++) {
    history.append('fn8', entry({ logs: `run-${i}` }));
  }
  assert.strictEqual(lineCount('fn8'), history.MAX_ENTRIES + 5,
    'append should not rewrite the file to trim');

  const entries = history.list('fn8');

  assert.strictEqual(entries.length, history.MAX_ENTRIES);
  assert.strictEqual(entries[0].logs, `run-${history.MAX_ENTRIES + 4}`);
  assert.strictEqual(lineCount('fn8'), history.MAX_ENTRIES,
    'list should compact the file it just trimmed');
});

// The read-side trim alone would let a long run that never opens the
// History tab grow the file without bound, so append keeps a cheap
// size guard (one stat, no parse).
test('append compacts on its own once the file passes the size guard', () => {
  process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES = '2000';
  try {
    for (let i = 0; i < history.MAX_ENTRIES + 10; i++) {
      history.append('fn9', entry({ logs: `run-${i}` }));
    }
    assert.ok(lineCount('fn9') <= history.MAX_ENTRIES,
      `file should self-compact, has ${lineCount('fn9')} lines`);
    assert.strictEqual(history.list('fn9')[0].logs, `run-${history.MAX_ENTRIES + 9}`,
      'compaction must keep the newest runs');
  } finally {
    delete process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES;
  }
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

test('compactBytes falls back to the default when the env override is not a number', () => {
  const prev = process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES;
  process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES = 'unlimited';
  try {
    assert.strictEqual(history.compactBytes(), history.COMPACT_BYTES);
  } finally {
    if (prev === undefined) delete process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES;
    else process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES = prev;
  }
});

test('clear removes the file', () => {
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
