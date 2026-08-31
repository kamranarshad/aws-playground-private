const { test } = require('node:test');
const assert = require('node:assert');
const s3Trigger = require('../../server/trigger/s3');
const localServices = require('../../server/services');
const originalLocalServicesStart = localServices.start;
const originalEnsureBucketConfig = s3Trigger.ensureBucketConfig;
const { categoryFor, normalizeRecord, dispatch } = s3Trigger;

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

test('dispatch decodes a "+" in the key back to a space for prefix matching and source.key', () => {
  const invoked = [];
  // S3/MinIO form-URL-encode a literal space as "+" (and a literal "+" as
  // "%2B"), so a prefix filter of "my " only matches once "+" is decoded.
  dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'my+file.txt'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'], prefix: 'my ' }],
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  assert.deepStrictEqual(invoked.map((i) => i.functionId), ['f1']);
  assert.strictEqual(invoked[0].source.key, 'my file.txt');
  assert.strictEqual(invoked[0].event.Records[0].s3.object.key, 'my+file.txt');
});

test('dispatch decodes an escaped literal "+" in the key as a "+", not a space', () => {
  const invoked = [];
  dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'a%2Bb.txt'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'], prefix: 'a+' }],
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  assert.deepStrictEqual(invoked.map((i) => i.functionId), ['f1']);
  assert.strictEqual(invoked[0].source.key, 'a+b.txt');
});

test('dispatch falls back to the raw key when it carries a malformed percent-sequence', () => {
  const invoked = [];
  dispatch(record('s3:ObjectCreated:Put', 'my-bucket', 'bad%ZZ.txt'), {
    routesFor: () => [{ functionId: 'f1', events: ['ObjectCreated'] }],
    invokeFunction: async (input) => { invoked.push(input); return { status: 200 }; },
  });
  assert.strictEqual(invoked[0].source.key, 'bad%ZZ.txt');
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
const { ensureBucket, syncBucketNotification } = require('../../server/trigger/s3');

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
const { createListener, PORT, HOST } = require('../../server/trigger/s3');

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

// sync/stop/status: the route table, MinIO bootstrap, and the bucketConfigQueue
// serialization. localServices.start and s3Trigger.ensureBucketConfig are
// monkeypatched throughout — real MinIO/network is exercised by
// tests/trigger-docker.test.js.

test('sync registers an s3 route, starts MinIO, and configures the bucket when a trigger is enabled', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    const fn = { id: 's1' };
    const trigger = { type: 's3', bucket: 'my-bucket', events: ['ObjectCreated'], enabled: true };

    await s3Trigger.sync(fn, trigger);

    assert.deepStrictEqual(calls, [{ bucket: 'my-bucket', hasWatchers: true }]);
    assert.deepStrictEqual(s3Trigger.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('my-bucket'),
      [{ functionId: fn.id, events: ['ObjectCreated'], prefix: undefined, suffix: undefined }]);

    s3Trigger.stop(fn.id);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('my-bucket'), []);
    // removeS3Route fires the hasWatchers:false ensureBucketConfig call through the
    // per-bucket queue, fire-and-forget — settle it before asserting on `calls`
    // (and, just as importantly, before `finally` restores the real one).
    await s3Trigger.drainBucketConfigQueue();
    assert.deepStrictEqual(calls[1], { bucket: 'my-bucket', hasWatchers: false });
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync is a no-op when the s3 trigger is unchanged', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    const fn = { id: 's2' };
    const trigger = { type: 's3', bucket: 'b2', events: ['ObjectCreated'], enabled: true };
    await s3Trigger.sync(fn, trigger);
    await s3Trigger.sync(fn, trigger);
    assert.strictEqual(calls, 1);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync reconfigures when the events, prefix, or suffix change', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    const fn = { id: 's3fn' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b3', events: ['ObjectCreated'], enabled: true });
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b3', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true });

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('b3'),
      [{ functionId: fn.id, events: ['ObjectCreated', 'ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('an events change is still detected when the stored list holds a duplicate', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    // Both validators dedupe now, so this can only come from data written
    // before they did — a hand-built trigger object skips that validation.
    // The old length + includes() comparison called this equal to
    // ['ObjectCreated', 'ObjectRemoved'] and silently skipped the update.
    const fn = { id: 's3dup' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'bdup', events: ['ObjectCreated', 'ObjectCreated'], enabled: true });
    await s3Trigger.sync(fn, { type: 's3', bucket: 'bdup', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true });

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('bdup'),
      [{ functionId: fn.id, events: ['ObjectCreated', 'ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('re-syncing an unchanged route whose stored events merely reordered is still a no-op', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    const fn = { id: 's3reorder' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'breorder', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true });
    await s3Trigger.sync(fn, { type: 's3', bucket: 'breorder', events: ['ObjectRemoved', 'ObjectCreated'], enabled: true });

    assert.strictEqual(calls, 1);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync stops the route and clears the bucket config when the trigger is disabled', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    const fn = { id: 's4' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b4', events: ['ObjectCreated'], enabled: true });
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b4', events: ['ObjectCreated'], enabled: false });
    await s3Trigger.drainBucketConfigQueue();

    assert.deepStrictEqual(s3Trigger.s3RoutesFor('b4'), []);
    assert.strictEqual(s3Trigger.status(fn.id), undefined);
    assert.deepStrictEqual(calls[calls.length - 1], { bucket: 'b4', hasWatchers: false });
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('the bucket config is only cleared once the last function watching it is removed', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    const a = { id: 's5a' };
    const b = { id: 's5b' };
    await s3Trigger.sync(a, { type: 's3', bucket: 'shared', events: ['ObjectCreated'], enabled: true });
    await s3Trigger.sync(b, { type: 's3', bucket: 'shared', events: ['ObjectRemoved'], enabled: true });

    s3Trigger.stop(a.id);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('shared'),
      [{ functionId: b.id, events: ['ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    assert.strictEqual(calls.filter((c) => c.hasWatchers === false).length, 0);

    s3Trigger.stop(b.id);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('shared'), []);
    // Same fire-and-forget queued call as above — settle it before asserting.
    await s3Trigger.drainBucketConfigQueue();
    assert.strictEqual(calls.filter((c) => c.hasWatchers === false).length, 1);
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a MinIO start failure is reported as an error status, not thrown', async () => {
  localServices.start = async () => ({ ok: false, state: 'stopped', output: 'port is already allocated' });
  // Stubbed even though the failing start means no enable-path call: the
  // stop() below still queues the disable-path clear, which would otherwise
  // reach a real MinIO over the network.
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const fn = { id: 's6' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b6', events: ['ObjectCreated'], enabled: true });
    const st = s3Trigger.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /port is already allocated/);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a bucket-config failure is reported as an error status, not thrown', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => { throw new Error('MinIO not running'); };
  const originalWarn = console.warn; // the disable path below logs; asserted on in its own test
  console.warn = () => {};
  try {
    const fn = { id: 's7' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b7', events: ['ObjectCreated'], enabled: true });
    const st = s3Trigger.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /MinIO not running/);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    console.warn = originalWarn;
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a failure to clear a bucket config on disable is logged rather than swallowed', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => {
    if (!hasWatchers) throw new Error('MinIO not running');
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const fn = { id: 's7b' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b7b', events: ['ObjectCreated'], enabled: true });
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /b7b/);
    assert.match(warnings[0], /MinIO not running/);
  } finally {
    console.warn = originalWarn;
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('disabling then immediately re-enabling an s3 trigger on the same bucket keeps ensureBucketConfig calls strictly ordered', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  let releaseDisableCall;
  const disableGate = new Promise((resolve) => { releaseDisableCall = resolve; });
  // Only the disable call (hasWatchers: false) is delayed — this simulates the
  // disable's real network call being slow (e.g. SDK retry/backoff) while the
  // re-enable races ahead with more synchronous work of its own (starting MinIO).
  // If ensureBucketConfig calls for the same bucket weren't serialized, the
  // re-enable's call could resolve first and then be clobbered when the slow
  // disable call finally lands, leaving the bucket's live config empty.
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => {
    if (hasWatchers === false) await disableGate;
    calls.push({ bucket, hasWatchers });
  };
  try {
    const fn = { id: 's10' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: true });

    const disableSync = s3Trigger.sync(fn,
      { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: false }); // fires the (delayed) hasWatchers:false call, fire-and-forget

    const enableSync = s3Trigger.sync(fn,
      { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: true }); // must queue its hasWatchers:true call behind the pending disable call

    releaseDisableCall();
    await Promise.all([disableSync, enableSync]);

    assert.deepStrictEqual(calls, [
      { bucket: 'race-bucket', hasWatchers: true },
      { bucket: 'race-bucket', hasWatchers: false },
      { bucket: 'race-bucket', hasWatchers: true },
    ]);
    assert.deepStrictEqual(s3Trigger.s3RoutesFor('race-bucket'),
      [{ functionId: fn.id, events: ['ObjectCreated'], prefix: undefined, suffix: undefined }]);
    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a failed S3 listener bind is surfaced as an error status on every s3-triggered function', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const fn = { id: 's11' };
    await s3Trigger.sync(fn, { type: 's3', bucket: 'b11', events: ['ObjectCreated'], enabled: true });
    assert.deepStrictEqual(s3Trigger.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });

    // bin/cli.js reports the shared listener's bind failure in here; without
    // it the function would keep claiming 'listening' with nothing able to
    // reach it.
    s3Trigger.setS3ListenerError(new Error('EADDRINUSE: address already in use 127.0.0.1:9501'));
    assert.deepStrictEqual(s3Trigger.status(fn.id), {
      state: 'error',
      lastError: 'EADDRINUSE: address already in use 127.0.0.1:9501',
      lastPolledAt: null,
    });
    assert.deepStrictEqual(s3Trigger.statusAll()[fn.id], s3Trigger.status(fn.id));

    s3Trigger.stop(fn.id);
    await s3Trigger.drainBucketConfigQueue();
    // Nothing is registered any more, so the dead listener stops colouring it.
    assert.strictEqual(s3Trigger.status(fn.id), undefined);
  } finally {
    s3Trigger.setS3ListenerError(null);
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});
