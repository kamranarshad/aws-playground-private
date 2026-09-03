const { test } = require('node:test');
const assert = require('node:assert');
const schema = require('../../server/schema');

test('validateTrigger accepts each supported trigger type', () => {
  assert.strictEqual(schema.validateTrigger({ type: 'http', enabled: true }), null);
  assert.strictEqual(schema.validateTrigger({ type: 'sqs', queueName: 'q', enabled: true }), null);
  assert.strictEqual(schema.validateTrigger({ type: 'dynamodb', tableName: 't', enabled: false }), null);
  assert.strictEqual(schema.validateTrigger(
    { type: 's3', bucket: 'b', events: ['ObjectCreated'], enabled: true }), null);
  assert.strictEqual(schema.validateTrigger(null), null);
});

test('validateTrigger explains each rejection', () => {
  assert.match(schema.validateTrigger({ type: 'kinesis', enabled: true }), /unsupported trigger type/);
  assert.match(schema.validateTrigger({ type: 'sqs', queueName: '  ', enabled: true }), /queueName is required/);
  assert.match(schema.validateTrigger({ type: 'dynamodb', tableName: '', enabled: true }), /tableName is required/);
  assert.match(schema.validateTrigger({ type: 's3', events: ['ObjectCreated'], enabled: true }), /bucket is required/);
  assert.match(schema.validateTrigger({ type: 's3', bucket: 'b', events: [], enabled: true }), /non-empty array/);
  assert.match(schema.validateTrigger({ type: 'http' }), /enabled must be a boolean/);
});

test('validateTrigger dedupes s3 events in place', () => {
  const trigger = { type: 's3', bucket: 'b', events: ['ObjectCreated', 'ObjectCreated'], enabled: true };
  assert.strictEqual(schema.validateTrigger(trigger), null);
  assert.deepStrictEqual(trigger.events, ['ObjectCreated']);
});

test('coerceTrigger drops invalid values instead of explaining them', () => {
  assert.strictEqual(schema.coerceTrigger({ type: 'kinesis' }), null);
  assert.strictEqual(schema.coerceTrigger({ type: 'sqs', queueName: '   ' }), null);
  assert.strictEqual(schema.coerceTrigger(undefined), null);
  assert.deepStrictEqual(schema.coerceTrigger({ type: 'sqs', queueName: '  q  ' }),
    { type: 'sqs', queueName: 'q', enabled: true });
  assert.deepStrictEqual(
    schema.coerceTrigger({ type: 's3', bucket: 'b', events: ['ObjectCreated', 'bogus', 'ObjectCreated'] }),
    { type: 's3', bucket: 'b', events: ['ObjectCreated'], enabled: true });
});

test('a playground.json trigger is always enabled — declaring it is opting in', () => {
  assert.strictEqual(schema.coerceTrigger({ type: 'http', enabled: false }).enabled, true);
});

test('validateFields rejects the values that would break an invoke', () => {
  const list = () => [];
  const get = () => null;
  assert.match(schema.validateFields({ runtime: 'ruby' }, { list, get }), /unsupported runtime/);
  assert.match(schema.validateFields({ timeoutMs: 'soon' }, { list, get }), /timeoutMs must be a positive number/);
  assert.match(schema.validateFields({ memoryMb: 0 }, { list, get }), /memoryMb must be a positive number/);
  assert.match(schema.validateFields({ autoTrace: 'yes' }, { list, get }), /autoTrace must be a boolean/);
  assert.strictEqual(schema.validateFields({ runtime: 'node', timeoutMs: 1, memoryMb: 1 }, { list, get }), null);
});

test('validateFields rejects a duplicate name but not the function itself', () => {
  const list = () => [{ id: 'a', name: 'taken' }];
  const get = () => null;
  assert.match(schema.validateFields({ name: 'taken' }, { list, get }), /already exists/);
  assert.strictEqual(schema.validateFields({ name: 'taken' }, { currentId: 'a', list, get }), null);
});

test('validateFields guards http routing on a rename with no trigger in the patch', () => {
  const list = () => [{ id: 'a', name: 'a' }];
  const get = () => ({ id: 'a', name: 'a', trigger: { type: 'http', enabled: true } });
  assert.match(schema.validateFields({ name: 'has/slash' }, { currentId: 'a', list, get }),
    /without '\/' characters/);
});

test('DEFAULTS covers every key store.create sets', () => {
  for (const k of ['handler', 'timeoutMs', 'memoryMb', 'jarPath', 'env', 'envFile',
    'buildCommand', 'localServices', 'savedEvents', 'trigger', 'autoTrace']) {
    assert.ok(k in schema.DEFAULTS, `DEFAULTS is missing ${k}`);
  }
});

test('schema constants are the shared package constants, not copies', () => {
  const shared = require('../../shared');
  assert.strictEqual(schema.RUNTIMES, shared.RUNTIMES);
  assert.strictEqual(schema.ALLOWED_KEYS, shared.ALLOWED_KEYS);
  assert.strictEqual(schema.DEFAULTS, shared.DEFAULTS);
});
