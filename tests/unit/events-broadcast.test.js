const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { writeDockerShim, writeScenario } = require('../helpers');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-events-'));
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-eventsvc-'));
const { shim: SHIM, scenario: SCENARIO } = writeDockerShim(SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;

const api = require('../../server/api');
const events = require('../../server/api/events');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

// A fake SSE client: subscribes through the real handler and records the
// event names written to it. Broadcasts must reach subscribers no matter
// which caller drove the state change (HTTP route, trigger fire, CLI), so
// these tests call the api layer directly — the same way trigger/manager.js
// and bin/cli.js do — rather than going through the HTTP router.
function subscribe() {
  const chunks = [];
  const req = new EventEmitter();
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() {},
  };
  events.handleEventsSubscription(req, res);
  return {
    names: () => chunks.join('')
      .split('\n\n')
      .map((m) => m.match(/^event: (.+)$/m)?.[1])
      .filter(Boolean),
    close: () => req.emit('close'),
  };
}

after(() => events.closeAll());

test('function create/update/delete broadcast functions events', () => {
  const client = subscribe();
  try {
    const created = api.createFunction({ name: 'evt-crud',
      path: path.join(FIXTURES, 'javascript', 'hello'),
      runtime: 'node', handler: 'index.handler' });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(client.names(), ['functions']);

    api.updateFunction(created.body.id, { timeoutMs: 5000 });
    assert.deepStrictEqual(client.names(), ['functions', 'functions']);

    api.deleteFunction(created.body.id);
    assert.deepStrictEqual(client.names(), ['functions', 'functions', 'functions']);
  } finally {
    client.close();
  }
});

test('rejected mutations broadcast nothing', () => {
  const client = subscribe();
  try {
    assert.strictEqual(api.createFunction({ name: 'nope' }).status, 400);
    assert.strictEqual(api.updateFunction('missing', {}).status, 404);
    assert.strictEqual(api.deleteFunction('missing').status, 404);
    assert.deepStrictEqual(client.names(), []);
  } finally {
    client.close();
  }
});

// The regression that matters: a trigger fire calls invokeFunction directly
// (see trigger/manager.js), never passing through the HTTP router — the UI
// must still hear about the new history entry.
test('invokeFunction broadcasts a history event without going through the router', async () => {
  const created = api.createFunction({ name: 'evt-invoke',
    path: path.join(FIXTURES, 'javascript', 'hello'),
    runtime: 'node', handler: 'index.handler' });
  assert.strictEqual(created.status, 201);
  const client = subscribe();
  try {
    const r = await api.invokeFunction({ functionId: created.body.id, event: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body.error ?? {}).slice(0, 200));
    assert.deepStrictEqual(client.names(), ['history']);
  } finally {
    client.close();
    api.deleteFunction(created.body.id);
  }
});

test('clearHistory broadcasts a history event', () => {
  const created = api.createFunction({ name: 'evt-clear',
    path: path.join(FIXTURES, 'javascript', 'hello'),
    runtime: 'node', handler: 'index.handler' });
  const client = subscribe();
  try {
    assert.strictEqual(api.clearHistory(created.body.id).status, 204);
    assert.deepStrictEqual(client.names(), ['history']);
  } finally {
    client.close();
    api.deleteFunction(created.body.id);
  }
});

test('service start/stop and selection broadcast services events', async () => {
  writeScenario(SCENARIO, {
    inspect: { code: 0, stdout: 'false' },
    start: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: 'x' },
  });
  const client = subscribe();
  try {
    assert.strictEqual((await api.startService('minio', { waitReady: false })).status, 200);
    assert.strictEqual((await api.stopService('minio')).status, 200);
    assert.strictEqual((await api.startService('nope')).status, 404);
    assert.strictEqual((await api.setSelection({ functionId: null })).status, 200);
    assert.deepStrictEqual(client.names(), ['services', 'services', 'services']);
  } finally {
    client.close();
  }
});
