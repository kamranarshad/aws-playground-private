const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { invoke } = require('../server/invoker');
const { hasRuntime } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');

function base(fixture, extra = {}) {
  return {
    name: 'test-fn',
    dir: path.join(FIXTURES, fixture),
    runtime: 'python',
    handler: 'app.handler',
    event: {},
    ...extra,
  };
}

test('python happy path: response, logs, report', { skip: noPy }, async () => {
  const r = await invoke(base('python-hello', { event: { x: 1 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from python');
  assert.deepStrictEqual(r.response.echo, { x: 1 });
  assert.ok(r.logs.includes('hello log line'));
  assert.ok(r.report.requestId.length > 10);
  assert.ok(r.report.durationMs >= 0);
  assert.ok(r.report.billedMs >= 1);
  assert.strictEqual(r.report.memoryMb, 128);
  assert.strictEqual(r.report.timedOut, false);
});

test('handler exception surfaces lambda-style error', { skip: noPy }, async () => {
  const r = await invoke(base('python-error'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'invoke');
  assert.strictEqual(r.error.type, 'ValueError');
  assert.strictEqual(r.error.message, 'boom from python');
});

test('timeout kills the process and reports Task timed out', { skip: noPy }, async () => {
  const r = await invoke(base('python-timeout', { timeoutMs: 1000 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Sandbox.Timedout');
  assert.strictEqual(r.error.message, 'Task timed out after 1.00 seconds');
  assert.strictEqual(r.report.timedOut, true);
});

test('env: AWS defaults set, user vars override, host env does not leak', { skip: noPy }, async () => {
  process.env.SHOULD_NOT_LEAK = 'secret';
  const r = await invoke(base('python-env-echo', {
    env: { CUSTOM_VAR: '42', AWS_REGION: 'eu-west-1' } }));
  delete process.env.SHOULD_NOT_LEAK;
  assert.strictEqual(r.response.region, 'eu-west-1');
  assert.strictEqual(r.response.fnName, 'test-fn');
  assert.strictEqual(r.response.custom, '42');
  assert.strictEqual(r.response.leak, null);
});

test('process exit without envelope -> Runtime.ExitError with logs', { skip: noPy }, async () => {
  const r = await invoke(base('python-crash'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Runtime.ExitError');
  assert.ok(r.error.message.includes('exit code 3'));
  assert.ok(r.logs.includes('about to exit hard'));
});

test('proxy and TLS trust vars pass through, unrelated host vars still do not', async () => {
  const passthrough = {
    HTTPS_PROXY: 'http://proxy.corp:8080',
    http_proxy: 'http://proxy.corp:8080',
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    AWS_CA_BUNDLE: '/etc/ssl/corp-bundle.pem',
    REQUESTS_CA_BUNDLE: '/etc/ssl/corp-bundle.pem',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
  };
  Object.assign(process.env, passthrough, { SHOULD_NOT_LEAK: 'secret' });
  try {
    const r = await invoke(base('node-env-echo', {
      runtime: 'node',
      handler: 'index.handler',
      event: { keys: [...Object.keys(passthrough), 'SHOULD_NOT_LEAK'] },
    }));
    for (const [key, value] of Object.entries(passthrough)) {
      assert.strictEqual(r.response[key], value, `${key} should reach the handler`);
    }
    assert.strictEqual(r.response.SHOULD_NOT_LEAK, null);
  } finally {
    for (const key of [...Object.keys(passthrough), 'SHOULD_NOT_LEAK']) delete process.env[key];
  }
});

test('node runtime works through the invoker', async () => {
  const r = await invoke(base('node-hello', { runtime: 'node', handler: 'index.handler' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from node');
});

test('unknown runtime throws', async () => {
  await assert.rejects(() => invoke(base('python-hello', { runtime: 'ruby' })),
    /Unknown runtime/);
});
