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

test('oversized fields are truncated and flagged', () => {
  const big = 'x'.repeat(history.MAX_FIELD_BYTES + 1000);
  const stored = history.append('fn3', entry({ logs: big, event: { blob: big } }));
  assert.strictEqual(stored.truncated, true);
  assert.ok(Buffer.byteLength(stored.logs, 'utf8') <= history.MAX_FIELD_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.event), 'utf8') <= history.MAX_FIELD_BYTES + 16);
  const listed = history.list('fn3')[0];
  assert.strictEqual(listed.truncated, true);
});

test('small entries are not flagged truncated', () => {
  const stored = history.append('fn4', entry());
  assert.strictEqual(stored.truncated, false);
});

test('clear removes the file', () => {
  history.append('fn5', entry());
  assert.strictEqual(history.clear('fn5'), true);
  assert.deepStrictEqual(history.list('fn5'), []);
  assert.strictEqual(history.clear('fn5'), false);
});
