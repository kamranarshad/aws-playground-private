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

test('dispatch decodes a percent-encoded key for prefix matching and source.key, but leaves the Records payload raw', () => {
  const invoked = [];
  dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'images%2Fpic.png'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'], prefix: 'images/' }],
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  assert.deepStrictEqual(invoked.map((i) => i.functionId), ['f1']);
  assert.strictEqual(invoked[0].source.key, 'images/pic.png');
  // Real S3-triggered Lambdas receive the still-encoded key and are expected
  // to decode it themselves — the Records payload mirrors that, unchanged.
  assert.strictEqual(invoked[0].event.Records[0].s3.object.key, 'images%2Fpic.png');
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

const {
  CreateBucketCommand, PutBucketNotificationConfigurationCommand,
} = require('@aws-sdk/client-s3');
const { ensureBucket, syncBucketNotification } = require('../server/trigger/s3');

function fakeClient() {
  const calls = [];
  return { calls, send: async (cmd) => { calls.push(cmd); return {}; } };
}

test('ensureBucket sends a CreateBucketCommand for the given bucket', async () => {
  const client = fakeClient();
  await ensureBucket(client, 'my-bucket');
  assert.strictEqual(client.calls.length, 1);
  assert.ok(client.calls[0] instanceof CreateBucketCommand);
  assert.strictEqual(client.calls[0].input.Bucket, 'my-bucket');
});

test('ensureBucket swallows a BucketAlreadyOwnedByYou/BucketAlreadyExists error', async () => {
  for (const name of ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists']) {
    const client = { send: async () => { const e = new Error('x'); e.name = name; throw e; } };
    await assert.doesNotReject(() => ensureBucket(client, 'my-bucket'));
  }
});

test('ensureBucket rethrows any other error', async () => {
  const client = { send: async () => { throw new Error('boom'); } };
  await assert.rejects(() => ensureBucket(client, 'my-bucket'), /boom/);
});

test('syncBucketNotification puts a catch-all config for both event types when hasWatchers is true', async () => {
  const client = fakeClient();
  await syncBucketNotification(client, 'my-bucket', true);
  assert.strictEqual(client.calls.length, 1);
  const cmd = client.calls[0];
  assert.ok(cmd instanceof PutBucketNotificationConfigurationCommand);
  assert.strictEqual(cmd.input.Bucket, 'my-bucket');
  const queueConfigs = cmd.input.NotificationConfiguration.QueueConfigurations;
  assert.strictEqual(queueConfigs.length, 1);
  assert.strictEqual(queueConfigs[0].QueueArn, 'arn:minio:sqs::PLAYGROUND:webhook');
  assert.deepStrictEqual(queueConfigs[0].Events, ['s3:ObjectCreated:*', 's3:ObjectRemoved:*']);
});

test('syncBucketNotification clears the config when hasWatchers is false', async () => {
  const client = fakeClient();
  await syncBucketNotification(client, 'my-bucket', false);
  assert.deepStrictEqual(client.calls[0].input.NotificationConfiguration.QueueConfigurations, []);
});

const http = require('node:http');
const { createListener, PORT, HOST } = require('../server/trigger/s3');

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('PORT and HOST match the fixed values MinIO is configured to reach', () => {
  assert.strictEqual(PORT, 9501);
  assert.strictEqual(HOST, '127.0.0.1');
});

test('the listener parses a MinIO webhook payload and invokes every matching route', async () => {
  const invoked = [];
  const listener = await createListener({
    port: 0,
    routesFor: (bucket) => (bucket === 'my-bucket' ? [{ functionId: 'f1', events: ['ObjectCreated'] }] : []),
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  try {
    const port = listener.server.address().port;
    const body = JSON.stringify({
      Records: [{ eventName: 's3:ObjectCreated:Put', s3: { bucket: { name: 'my-bucket' }, object: { key: 'hello.txt' } } }],
    });
    const res = await post(port, body);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(invoked.length, 1);
    assert.strictEqual(invoked[0].functionId, 'f1');
  } finally {
    listener.stop();
  }
});

test('the listener responds 200 for a malformed body and invokes nothing', async () => {
  let called = false;
  const listener = await createListener({
    port: 0,
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }],
    invokeFunction: async () => { called = true; },
  });
  try {
    const port = listener.server.address().port;
    const res = await post(port, 'not json');
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(called, false);
  } finally {
    listener.stop();
  }
});

test('the listener responds 200 for a payload with no Records', async () => {
  const listener = await createListener({ port: 0, routesFor: () => [], invokeFunction: async () => {} });
  try {
    const port = listener.server.address().port;
    const res = await post(port, JSON.stringify({}));
    assert.strictEqual(res.status, 200);
  } finally {
    listener.stop();
  }
});

test('the listener responds 200 for a payload with non-array Records and invokes nothing', async () => {
  let called = false;
  const listener = await createListener({
    port: 0,
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }],
    invokeFunction: async () => { called = true; },
  });
  try {
    const port = listener.server.address().port;
    const res = await post(port, JSON.stringify({ Records: 5 }));
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(called, false);
  } finally {
    listener.stop();
  }
});

test('the listener responds 200 for a payload with null records and invokes nothing', async () => {
  let called = false;
  const listener = await createListener({
    port: 0,
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }],
    invokeFunction: async () => { called = true; },
  });
  try {
    const port = listener.server.address().port;
    const res = await post(port, JSON.stringify({ Records: [null] }));
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(called, false);
  } finally {
    listener.stop();
  }
});
