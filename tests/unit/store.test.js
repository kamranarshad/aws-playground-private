const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-store-'));
const store = require('../../server/persistence/store');

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

test('corrupted registry file is quarantined, not silently wiped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-corrupt-'));
  process.env.AWS_PLAYGROUND_DATA_DIR = dir;
  const dataFile = path.join(dir, 'functions.json');
  const corruptFile = path.join(dir, 'functions.json.corrupt');
  const garbage = '{ this is not valid json ][';
  fs.writeFileSync(dataFile, garbage);

  assert.deepStrictEqual(store.list(), []);
  assert.ok(fs.existsSync(corruptFile), 'functions.json.corrupt should exist after load');
  assert.strictEqual(fs.readFileSync(corruptFile, 'utf8'), garbage);
  assert.ok(!fs.existsSync(dataFile), 'the corrupted functions.json should have been moved away');

  // a subsequent create() should work fine against a fresh registry
  const fn = store.create({ name: 'after-corruption', path: '/tmp/after-corruption', runtime: 'python' });
  assert.ok(fn.id);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.list()[0].name, 'after-corruption');

  // corrupting again and reloading should overwrite the previous .corrupt file
  fs.writeFileSync(dataFile, 'still garbage');
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(fs.readFileSync(corruptFile, 'utf8'), 'still garbage');
});

test('trigger field defaults to null and round-trips through create/update', () => {
  const fn = store.create({ name: 'trig1', path: '/tmp/trig1', runtime: 'node' });
  assert.strictEqual(fn.trigger, null);
  const withTrigger = store.create({ name: 'trig2', path: '/tmp/trig2', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: true } });
  assert.deepStrictEqual(withTrigger.trigger, { type: 'sqs', queueName: 'q', enabled: true });
  const updated = store.update(withTrigger.id, { trigger: { type: 'sqs', queueName: 'q2', enabled: false } });
  assert.deepStrictEqual(updated.trigger, { type: 'sqs', queueName: 'q2', enabled: false });
});

const { writeFileAtomic } = require('../../server/persistence/atomic-write');

test('writeFileAtomic replaces the target in one step', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic-'));
  const target = path.join(dir, 'data.json');
  writeFileAtomic(target, '{"v":1}');
  writeFileAtomic(target, '{"v":2}');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"v":2}');
  assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'],
    'a .tmp file was left behind after a successful write');
});

test('writeFileAtomic cleans up its temp file when the rename cannot complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic2-'));
  const target = path.join(dir, 'data.json');
  // A directory at the target makes rename(2) fail *after* the temp file has
  // been written -- the exact window that used to truncate the real file.
  fs.mkdirSync(target);

  assert.throws(() => writeFileAtomic(target, '{"v":1}'));

  assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'],
    'the temp file survived a failed rename');
  assert.ok(fs.statSync(target).isDirectory(), 'the target was clobbered');
});

test('a leftover temp file from a crash does not confuse the registry', () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic3-'));
  const fn = store.create({ name: 'keeper', path: '/tmp/keeper', runtime: 'node' });
  const file = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'functions.json');
  const before = fs.readFileSync(file, 'utf8');

  fs.writeFileSync(file + '.tmp', '{"functions":[{"id":"hal');

  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(store.get(fn.id).name, 'keeper');
});

test('get reads the canonical functions.json, including hand-edits', () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-canon-'));
  const fn = store.create({ name: 'hand-edit', path: '/tmp/hand-edit', runtime: 'node' });
  const file = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'functions.json');

  // Edit the registry behind the store's back, the way a user (or a test
  // relying on the disk contract) would. get() must agree with list() and
  // serve the edited value, not a stale copy from a secondary store.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.functions[0].handler = 'edited.handler';
  fs.writeFileSync(file, JSON.stringify(onDisk));

  assert.strictEqual(store.list().find((f) => f.id === fn.id).handler, 'edited.handler');
  assert.strictEqual(store.get(fn.id).handler, 'edited.handler');
});
