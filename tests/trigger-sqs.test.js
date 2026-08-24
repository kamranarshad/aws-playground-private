const { test } = require('node:test');
const assert = require('node:assert');
const { buildSqsEvent } = require('../server/trigger/sqs');

function message(overrides = {}) {
  return {
    MessageId: 'm1',
    ReceiptHandle: 'rh1',
    Body: '{"hello":"world"}',
    MD5OfBody: 'abc123',
    Attributes: {
      ApproximateReceiveCount: '2',
      SentTimestamp: '1700000000000',
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: '1700000000100',
    },
    MessageAttributes: {},
    ...overrides,
  };
}

test('buildSqsEvent shapes a real Lambda SQS event Records array', () => {
  const event = buildSqsEvent(message(), 'my-queue');
  assert.strictEqual(event.Records.length, 1);
  const record = event.Records[0];
  assert.strictEqual(record.messageId, 'm1');
  assert.strictEqual(record.receiptHandle, 'rh1');
  assert.strictEqual(record.body, '{"hello":"world"}');
  assert.strictEqual(record.md5OfBody, 'abc123');
  assert.strictEqual(record.eventSource, 'aws:sqs');
  assert.strictEqual(record.eventSourceARN, 'arn:aws:sqs:elasticmq:000000000000:my-queue');
  assert.strictEqual(record.awsRegion, 'elasticmq');
  assert.deepStrictEqual(record.attributes, {
    ApproximateReceiveCount: '2',
    SentTimestamp: '1700000000000',
    SenderId: 'AIDAEXAMPLE',
    ApproximateFirstReceiveTimestamp: '1700000000100',
  });
});

test('buildSqsEvent fills in safe defaults when SQS omits optional attributes', () => {
  const event = buildSqsEvent(message({ Attributes: undefined, MessageAttributes: undefined }), 'my-queue');
  assert.deepStrictEqual(event.Records[0].attributes, {
    ApproximateReceiveCount: '1', SentTimestamp: '', SenderId: '', ApproximateFirstReceiveTimestamp: '',
  });
  assert.deepStrictEqual(event.Records[0].messageAttributes, {});
});
