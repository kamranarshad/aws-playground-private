const { test } = require('node:test');
const assert = require('node:assert');
const { categoryFor, normalizeRecord, dispatch } = require('../server/trigger/s3');

test('categoryFor maps the two supported wildcard event names, and rejects everything else', () => {
  assert.strictEqual(categoryFor('s3:ObjectCreated:Put'), 'ObjectCreated');
  assert.strictEqual(categoryFor('s3:ObjectCreated:CompleteMultipartUpload'), 'ObjectCreated');
  assert.strictEqual(categoryFor('s3:ObjectRemoved:Delete'), 'ObjectRemoved');
  assert.strictEqual(categoryFor('s3:ObjectTagging:Put'), null);
  assert.strictEqual(categoryFor(undefined), null);
  assert.strictEqual(categoryFor(null), null);
});

test('normalizeRecord rewrites MinIO\'s eventSource to aws:s3 without mutating the input', () => {
  const input = { eventSource: 'minio:s3', eventName: 's3:ObjectCreated:Put', s3: { object: { key: 'x' } } };
  const record = normalizeRecord(input);
  assert.strictEqual(record.eventSource, 'aws:s3');
  assert.strictEqual(record.eventName, 's3:ObjectCreated:Put');
  assert.strictEqual(input.eventSource, 'minio:s3');
});

function record(eventName, bucket, key) {
  return { eventName, eventSource: 'minio:s3', s3: { bucket: { name: bucket }, object: { key } } };
}

test('dispatch invokes every route matching bucket, event category, prefix, and suffix', () => {
  const invoked = [];
  const routes = {
    'my-bucket': [
      { functionId: 'f1', events: ['ObjectCreated'] },
      { functionId: 'f2', events: ['ObjectCreated'], prefix: 'images/' },
      { functionId: 'f3', events: ['ObjectRemoved'] },
      { functionId: 'f4', events: ['ObjectCreated'], suffix: '.txt' },
    ],
  };
  dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'images/pic.png'), {
    routesFor: (bucket) => routes[bucket] ?? [],
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  assert.deepStrictEqual(invoked.map((i) => i.functionId), ['f1', 'f2']);
  assert.deepStrictEqual(invoked[0].event, {
    Records: [{ eventName: 's3:ObjectCreated:Put', eventSource: 'aws:s3',
      s3: { bucket: { name: 'my-bucket' }, object: { key: 'images/pic.png' } } }],
  });
  assert.deepStrictEqual(invoked[0].source,
    { type: 'trigger', bucket: 'my-bucket', key: 'images/pic.png', eventName: 's3:ObjectCreated:Put' });
});

test('dispatch is a no-op for an unrouted bucket or an unrecognized event name', () => {
  let called = false;
  const invokeFunction = async () => { called = true; };
  dispatch(record('s3:ObjectCreated:Put', 'no-routes', 'x'), { routesFor: () => [], invokeFunction });
  dispatch(record('s3:ObjectTagging:Put', 'my-bucket', 'x'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }], invokeFunction,
  });
  assert.strictEqual(called, false);
});

test('dispatch never throws when invokeFunction rejects', () => {
  assert.doesNotThrow(() => dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'x'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }],
    invokeFunction: async () => { throw new Error('boom'); },
  }));
});
