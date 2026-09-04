const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDb, close } = require('../../server/persistence/sqlite');

test('sqlite initializes database, schema, and wal mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-sqlite-'));
  const db = getDb(dir);
  assert.ok(fs.existsSync(path.join(dir, 'playground.db')));

  // Check tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('functions'));
  assert.ok(tables.includes('history'));

  // Test functions insert and query
  db.prepare('INSERT INTO functions (id, name, data) VALUES (?, ?, ?)')
    .run('fn-1', 'testFunction', JSON.stringify({ id: 'fn-1', name: 'testFunction' }));
  const fnRow = db.prepare('SELECT * FROM functions WHERE id = ?').get('fn-1');
  assert.strictEqual(fnRow.name, 'testFunction');
  assert.deepStrictEqual(JSON.parse(fnRow.data), { id: 'fn-1', name: 'testFunction' });

  // Test history insert and index query
  db.prepare('INSERT INTO history (id, function_id, request_id, ts, data) VALUES (?, ?, ?, ?, ?)')
    .run('hist-1', 'fn-1', 'req-1', 1000, JSON.stringify({ id: 'hist-1', report: { requestId: 'req-1' } }));
  const histRow = db.prepare('SELECT * FROM history WHERE request_id = ?').get('req-1');
  assert.strictEqual(histRow.id, 'hist-1');

  close();
});
