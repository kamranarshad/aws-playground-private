const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDockerShim, writeScenario } = require('../helpers');

// Hermetic like tests/services.test.js: a shim "docker" for the dynamodb
// start (localServices.start), and a monkeypatched poller.start for the poll
// loop itself — real network/docker is exercised by tests/trigger-docker.test.js.
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-ddb-'));
const { shim: SHIM, scenario: SCENARIO, calls: CALLS } = writeDockerShim(SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-ddb-data-'));

function scenario(map) {
  writeScenario(SCENARIO, map);
  fs.writeFileSync(CALLS, '');
}

// The docker shim's "inspect" scenario key is container-agnostic (see
// writeDockerShim in helpers.js), so this works unchanged for the
// dynamodb-local container too.
function dynamodbAlreadyRunning() {
  scenario({ inspect: { code: 0, stdout: 'true' } });
}

const dynamodbTrigger = require('../../server/trigger/dynamodb');
const store = require('../../server/persistence/store');
const localServices = require('../../server/services');
const originalLocalServicesStart = localServices.start;
const originalStart = dynamodbTrigger.start;

const { buildDynamoDbEvent } = dynamodbTrigger;

function record(overrides = {}) {
  return {
    eventID: 'e1',
    eventName: 'INSERT',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'local',
    dynamodb: {
      ApproximateCreationDateTime: new Date(1700000000000),
      Keys: { id: { S: 'abc' } },
      NewImage: { id: { S: 'abc' }, name: { S: 'hi' } },
      SequenceNumber: '111',
      SizeBytes: 26,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
    ...overrides,
  };
}

test('buildDynamoDbEvent shapes a real Lambda DynamoDB Streams Records array', () => {
  const event = buildDynamoDbEvent([record()], 'arn:aws:dynamodb:local:000000000000:table/t/stream/2026-08-26T00:00:00.000');
  assert.strictEqual(event.Records.length, 1);
  const r = event.Records[0];
  assert.strictEqual(r.eventID, 'e1');
  assert.strictEqual(r.eventName, 'INSERT');
  assert.strictEqual(r.eventVersion, '1.1');
  assert.strictEqual(r.eventSource, 'aws:dynamodb');
  assert.strictEqual(r.awsRegion, 'local');
  assert.strictEqual(r.eventSourceARN, 'arn:aws:dynamodb:local:000000000000:table/t/stream/2026-08-26T00:00:00.000');
  assert.deepStrictEqual(r.dynamodb.Keys, { id: { S: 'abc' } });
  assert.deepStrictEqual(r.dynamodb.NewImage, { id: { S: 'abc' }, name: { S: 'hi' } });
  assert.strictEqual(r.dynamodb.SequenceNumber, '111');
  assert.strictEqual(r.dynamodb.SizeBytes, 26);
  assert.strictEqual(r.dynamodb.StreamViewType, 'NEW_AND_OLD_IMAGES');
  assert.strictEqual(r.dynamodb.ApproximateCreationDateTime, 1700000000);
});

test('buildDynamoDbEvent turns a whole GetRecords batch into one event, one entry per record', () => {
  const event = buildDynamoDbEvent([record({ eventID: 'e1' }), record({ eventID: 'e2', eventName: 'MODIFY' })], 'arn1');
  assert.strictEqual(event.Records.length, 2);
  assert.strictEqual(event.Records[0].eventID, 'e1');
  assert.strictEqual(event.Records[1].eventID, 'e2');
  assert.strictEqual(event.Records[1].eventName, 'MODIFY');
});

// Shared in-flight guard / backoff / sleep-on-empty behavior lives in
// poller.js now and is tested once, generically, in tests/trigger-poller.test.js.

test('sync starts dynamodb-local and the poll loop when a trigger is enabled', async () => {
  dynamodbAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const stop = () => { stop.called = true; };
    dynamodbTrigger.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
    const fn = store.create({ name: 'd1', path: '/tmp/d1', runtime: 'node',
      trigger: { type: 'dynamodb', tableName: 'tbl1', enabled: true } });

    await dynamodbTrigger.sync(fn, fn.trigger);

    assert.deepStrictEqual(dynamodbTrigger.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    dynamodbTrigger.stop(fn.id);
    assert.strictEqual(stop.called, true);
  } finally {
    localServices.start = originalLocalServicesStart;
    dynamodbTrigger.start = originalStart;
  }
});

test('sync is a no-op when the dynamodb trigger is already running against the same table', async () => {
  dynamodbAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let starts = 0;
    dynamodbTrigger.start = (fn, { onStatus }) => {
      starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} };
    };
    const fn = store.create({ name: 'd2', path: '/tmp/d2', runtime: 'node',
      trigger: { type: 'dynamodb', tableName: 'tbl2', enabled: true } });

    await dynamodbTrigger.sync(fn, fn.trigger);
    await dynamodbTrigger.sync(fn, fn.trigger);

    assert.strictEqual(starts, 1);
    dynamodbTrigger.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    dynamodbTrigger.start = originalStart;
  }
});

test('sync restarts the dynamodb poller when the table name changes', async () => {
  dynamodbAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const stopped = [];
    let n = 0;
    dynamodbTrigger.start = (fn, { onStatus }) => {
      n++;
      const id = n;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => stopped.push(id) };
    };
    let fn = store.create({ name: 'd3', path: '/tmp/d3', runtime: 'node',
      trigger: { type: 'dynamodb', tableName: 'tbl3', enabled: true } });
    await dynamodbTrigger.sync(fn, fn.trigger);
    fn = store.update(fn.id, { trigger: { type: 'dynamodb', tableName: 'tbl3-renamed', enabled: true } });
    await dynamodbTrigger.sync(fn, fn.trigger);

    assert.deepStrictEqual(stopped, [1]);
    assert.strictEqual(n, 2);
    dynamodbTrigger.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    dynamodbTrigger.start = originalStart;
  }
});

test('sync stops the dynamodb poller when the trigger is disabled', async () => {
  dynamodbAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let stopped = false;
    dynamodbTrigger.start = (fn, { onStatus }) => {
      onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } };
    };
    let fn = store.create({ name: 'd4', path: '/tmp/d4', runtime: 'node',
      trigger: { type: 'dynamodb', tableName: 'tbl4', enabled: true } });
    await dynamodbTrigger.sync(fn, fn.trigger);
    fn = store.update(fn.id, { trigger: { type: 'dynamodb', tableName: 'tbl4', enabled: false } });
    await dynamodbTrigger.sync(fn, fn.trigger);

    assert.strictEqual(stopped, true);
    assert.strictEqual(dynamodbTrigger.status(fn.id), undefined);
  } finally {
    localServices.start = originalLocalServicesStart;
    dynamodbTrigger.start = originalStart;
  }
});

test('a dynamodb-local start failure is reported as an error status, not thrown', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 125, stdout: 'port is already allocated' } });
  // Restore the real localServices.start to exercise the real docker-shim
  // failure path (the docker run command fails before ever reaching
  // waitReady, so this is fast — the next test re-mocks it immediately).
  localServices.start = originalLocalServicesStart;
  try {
    const fn = store.create({ name: 'd5', path: '/tmp/d5', runtime: 'node',
      trigger: { type: 'dynamodb', tableName: 'tbl5', enabled: true } });

    await dynamodbTrigger.sync(fn, fn.trigger);

    const st = dynamodbTrigger.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /port is already allocated/);
    dynamodbTrigger.stop(fn.id);
  } finally {
    // No need to restore here since the next test sets its own monkeypatch
  }
});
