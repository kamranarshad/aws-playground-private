const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { effectiveTrigger } = require('../server/trigger/effective');

function proj(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-eff-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'playground.json'), content);
  return dir;
}

test('a playground.json trigger wins over the manually-stored one', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'http' } }));
  const fn = { path: dir, trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'http', enabled: true });
});

test('falls back to the manually-stored trigger when playground.json declares none', () => {
  const dir = proj(); // no playground.json at all
  const fn = { path: dir, trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'sqs', queueName: 'manual-queue', enabled: true });
});

test('returns null when neither playground.json nor the function declares a trigger', () => {
  const dir = proj();
  const fn = { path: dir, trigger: null };
  assert.strictEqual(effectiveTrigger(fn), null);
});

test('an invalid playground.json trigger falls back to the manual one, not null', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs' } })); // missing queueName -> invalid
  const fn = { path: dir, trigger: { type: 'http', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'http', enabled: true });
});

test('a playground.json dynamodb trigger wins over the manually-stored one', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'dynamodb', tableName: 'from-file' } }));
  const fn = { path: dir, trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'dynamodb', tableName: 'from-file', enabled: true });
});

test('an invalid playground.json dynamodb trigger (missing tableName) falls back to the manual one', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'dynamodb' } }));
  const fn = { path: dir, trigger: { type: 'http', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'http', enabled: true });
});
