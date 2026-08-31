const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { invoke } = require('../server/runtime/invoker');
const { hasOwnTracingSetup } = require('../server/trace/auto-trace-detect');
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
  const r = await invoke(base('python/hello', { event: { x: 1 } }));
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
  const r = await invoke(base('python/error'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'invoke');
  assert.strictEqual(r.error.type, 'ValueError');
  assert.strictEqual(r.error.message, 'boom from python');
});

test('timeout kills the process and reports Task timed out', { skip: noPy }, async () => {
  const r = await invoke(base('python/timeout', { timeoutMs: 1000 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Sandbox.Timedout');
  assert.strictEqual(r.error.message, 'Task timed out after 1.00 seconds');
  assert.strictEqual(r.report.timedOut, true);
});

test('env: AWS defaults set, user vars override, host env does not leak', { skip: noPy }, async () => {
  process.env.SHOULD_NOT_LEAK = 'secret';
  const r = await invoke(base('python/env-echo', {
    env: { CUSTOM_VAR: '42', AWS_REGION: 'eu-west-1' } }));
  delete process.env.SHOULD_NOT_LEAK;
  assert.strictEqual(r.response.region, 'eu-west-1');
  assert.strictEqual(r.response.fnName, 'test-fn');
  assert.strictEqual(r.response.custom, '42');
  assert.strictEqual(r.response.leak, null);
});

test('process exit without envelope -> Runtime.ExitError with logs', { skip: noPy }, async () => {
  const r = await invoke(base('python/crash'));
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
    const r = await invoke(base('javascript/env-echo', {
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
  const r = await invoke(base('javascript/hello', { runtime: 'node', handler: 'index.handler' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from node');
});

test('unknown runtime throws', async () => {
  await assert.rejects(() => invoke(base('python/hello', { runtime: 'ruby' })),
    /Unknown runtime/);
});

// spawn() reports a missing cwd as ENOENT against the *command*, so a project
// folder that moved used to surface as "is the node runtime installed?" —
// sending you off to reinstall a runtime that was never the problem.
test('missing project folder blames the folder, not the runtime', async () => {
  const r = await invoke(base('does-not-exist', { runtime: 'node', handler: 'index.handler' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'init');
  assert.strictEqual(r.error.type, 'Project.NotFound');
  assert.ok(r.error.message.includes(path.join(FIXTURES, 'does-not-exist')),
    `message should name the missing folder, got: ${r.error.message}`);
  assert.ok(!/runtime installed/.test(r.error.message),
    `message should not blame the runtime, got: ${r.error.message}`);
});

test('project path pointing at a file is reported as not a folder', async () => {
  const r = await invoke(base(path.join('javascript/hello', 'index.js'), {
    runtime: 'node', handler: 'index.handler' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Project.NotFound');
  assert.ok(/not a folder/.test(r.error.message),
    `message should say it is not a folder, got: ${r.error.message}`);
});

test('invoke() always returns a trace field, even with no OTel SDK involved', async () => {
  const r = await invoke(base('javascript/hello', { runtime: 'node', handler: 'index.handler', id: 'fn-trace-test' }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.trace, { spans: [], pending: true });
});

test('invoke() injects OTLP env vars pointed at the trace receiver', async () => {
  const r = await invoke(base('javascript/env-echo', {
    runtime: 'node', handler: 'index.handler', id: 'fn-trace-env',
    event: { keys: ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_RESOURCE_ATTRIBUTES'] },
  }));
  assert.strictEqual(r.ok, true);
  assert.match(r.response.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, /^http:\/\/127\.0\.0\.1:\d+\/v1\/traces$/);
  assert.strictEqual(r.response.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, 'http/protobuf');
  assert.match(r.response.OTEL_RESOURCE_ATTRIBUTES, /^faas\.invocation_id=/);
});

test('autoTrace does not interfere with a handler that already sets up its own tracing (otel-span)',
  { skip: fs.existsSync(path.join(FIXTURES, 'typescript/otel-span/dist/index.js')) ? false : 'fixture dist not built' },
  async () => {
  const otelSpanDir = path.join(FIXTURES, 'typescript/otel-span');
  assert.strictEqual(hasOwnTracingSetup(otelSpanDir), true, 'precondition: otel-span must declare its own tracing');

  const r = await invoke(base('typescript/otel-span', {
    runtime: 'node', handler: 'dist/index.handler', autoTrace: true, id: 'fn-autotrace-skip-test',
  }));
  assert.strictEqual(r.ok, true);
  // otel-span's own manual pipeline produces exactly 5 spans (see its own
  // fixture source) -- if auto-tracing had incorrectly layered on top
  // instead of being skipped, this would differ (e.g. the handler's own
  // setGlobalTracerProvider silently rejected because the bootstrap won
  // the registration race -- exactly the failure mode detection exists to
  // prevent).
  assert.strictEqual(r.trace.spans.length, 5);
});
