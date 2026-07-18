const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-store-'));
const store = require('../server/store');

test('create applies defaults and persists to functions.json', () => {
  const fn = store.create({ name: 'fn1', path: '/tmp/fn1', runtime: 'python' });
  assert.ok(fn.id);
  assert.strictEqual(fn.handler, '');
  assert.strictEqual(fn.timeoutMs, 30000);
  assert.strictEqual(fn.memoryMb, 128);
  assert.strictEqual(fn.jarPath, null);
  assert.deepStrictEqual(fn.env, {});
  assert.deepStrictEqual(fn.savedEvents, []);
  const onDisk = JSON.parse(fs.readFileSync(
    path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'functions.json'), 'utf8'));
  assert.strictEqual(onDisk.functions.length, 1);
  assert.strictEqual(onDisk.functions[0].id, fn.id);
});

test('get, update, remove round-trip', () => {
  const fn = store.create({ name: 'fn2', path: '/tmp/fn2', runtime: 'node' });
  assert.strictEqual(store.get(fn.id).name, 'fn2');
  const updated = store.update(fn.id, { handler: 'index.handler', env: { A: '1' }, id: 'hack', bogus: true });
  assert.strictEqual(updated.handler, 'index.handler');
  assert.deepStrictEqual(updated.env, { A: '1' });
  assert.strictEqual(updated.id, fn.id);
  assert.strictEqual(updated.bogus, undefined);
  assert.strictEqual(store.update('missing', {}), null);
  assert.strictEqual(store.remove(fn.id), true);
  assert.strictEqual(store.remove(fn.id), false);
  assert.strictEqual(store.get(fn.id), null);
});

test('list returns empty array when file missing', () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-empty-'));
  assert.deepStrictEqual(store.list().filter(f => f.name === 'nope'), []);
});
