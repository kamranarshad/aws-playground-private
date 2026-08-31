const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-otel-'));
const traceReceiver = require('../server/trace/receiver');
const traceCollector = require('../server/trace/collector');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'node', 'harness.mjs');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'typescript/otel-span');
const built = fs.existsSync(path.join(FIXTURE, 'dist', 'index.js'));

function runHarness(event, requestId, otlpEndpoint) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hotel-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', 'dist/index.handler', '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', requestId],
      { cwd: FIXTURE, env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlpEndpoint,
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
        OTEL_RESOURCE_ATTRIBUTES: `faas.invocation_id=${requestId}`,
      } },
      () => {
        let envelope = null;
        try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); fs.unlinkSync(resultFile); } catch {}
        resolve(envelope);
      });
    child.stdin.end(JSON.stringify(event));
  });
}

test('a real OTel-instrumented handler\'s nested spans round-trip through the real /v1/traces receiver',
  { skip: built ? false : 'fixture dist not built' }, async () => {
  const requestId = 'req-e2e-otel';
  const endpoint = await traceReceiver.endpoint();
  traceCollector.open(requestId, 'fn-e2e-otel');

  const envelope = await runHarness({ name: 'world' }, requestId, endpoint);
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.greeting, 'hello, world');

  // the exporter's HTTP POST completes before the harness process exits
  // (forceFlush is awaited in the fixture handler), but the receiver still
  // processes it asynchronously relative to this test process
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { spans } = traceCollector.snapshotAndStartWindow(requestId);
  assert.strictEqual(spans.length, 5);
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  assert.ok(byName['handle-request']);
  assert.ok(byName['validate-input']);
  assert.ok(byName['fetch-data']);
  assert.ok(byName['db-query']);
  assert.ok(byName['build-response']);

  assert.strictEqual(byName['handle-request'].parentSpanId, null);
  assert.strictEqual(byName['validate-input'].parentSpanId, byName['handle-request'].spanId);
  assert.strictEqual(byName['fetch-data'].parentSpanId, byName['handle-request'].spanId);
  assert.strictEqual(byName['db-query'].parentSpanId, byName['fetch-data'].spanId);
  assert.strictEqual(byName['build-response'].parentSpanId, byName['handle-request'].spanId);

  assert.strictEqual(byName['handle-request'].attributes['event.name'], 'world');
  assert.strictEqual(byName['db-query'].attributes['db.system'], 'postgresql');
});
