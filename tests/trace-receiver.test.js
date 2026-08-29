const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-tr-'));
const traceReceiver = require('../server/trace-receiver');
const traceCollector = require('../server/trace-collector');

const { trace } = require('@opentelemetry/api');
const { resourceFromAttributes, detectResources, envDetector } = require('@opentelemetry/resources');
const { TracerProvider, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPTraceExporter: OTLPTraceExporterJson } = require('@opentelemetry/exporter-trace-otlp-http');

async function sendOneRealSpan(requestId, endpoint) {
  const prevAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES = `faas.invocation_id=${requestId}`;
  try {
    // A hand-built Resource does NOT pick up OTEL_RESOURCE_ATTRIBUTES on its
    // own -- only envDetector reads it, and it must be explicitly merged in.
    // Verified by hand while writing the design spec; this is the real
    // shape a correctly-configured handler needs.
    const resource = resourceFromAttributes({ 'service.name': 'trace-receiver-test' })
      .merge(detectResources({ detectors: [envDetector] }));
    const provider = new TracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter({ url: endpoint }) })],
    });
    const tracer = provider.getTracer('trace-receiver-test');
    const span = tracer.startSpan('do-work');
    span.setAttribute('custom.attr', 'value-1');
    span.end();
    await provider.forceFlush();
  } finally {
    if (prevAttrs === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = prevAttrs;
  }
}

// Same as sendOneRealSpan, but over OTLP/JSON -- the encoding whose
// trace/span IDs are plain hex rather than base64. Exercises decodeJson
// against the real transformer's output rather than a hand-built fixture.
async function sendOneRealSpanJson(requestId, endpoint) {
  const prevAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES = `faas.invocation_id=${requestId}`;
  try {
    const resource = resourceFromAttributes({ 'service.name': 'trace-receiver-test' })
      .merge(detectResources({ detectors: [envDetector] }));
    const provider = new TracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporterJson({ url: endpoint }) })],
    });
    const tracer = provider.getTracer('trace-receiver-test');
    const span = tracer.startSpan('do-work-json');
    span.setAttribute('custom.attr', 'value-json');
    span.end();
    await provider.forceFlush();
  } finally {
    if (prevAttrs === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = prevAttrs;
  }
}

test('a real OTel exporter\'s protobuf export correlates to the right requestId', async () => {
  const endpoint = await traceReceiver.endpoint();
  traceCollector.open('req-real-1', 'fn-real');
  await sendOneRealSpan('req-real-1', endpoint);
  // give the fire-and-forget HTTP POST a moment to be processed server-side
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { spans } = traceCollector.snapshotAndStartWindow('req-real-1');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].name, 'do-work');
  assert.strictEqual(spans[0].attributes['custom.attr'], 'value-1');
});

test('a real OTel exporter\'s JSON export correlates to the right requestId', async () => {
  const endpoint = await traceReceiver.endpoint();
  traceCollector.open('req-real-json-1', 'fn-real-json');
  await sendOneRealSpanJson('req-real-json-1', endpoint);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { spans } = traceCollector.snapshotAndStartWindow('req-real-json-1');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].name, 'do-work-json');
  assert.strictEqual(spans[0].attributes['custom.attr'], 'value-json');
  // The ID assertions are the point of this test: OTLP/JSON sends trace/span
  // IDs as plain hex, so decoding them as base64 (the generic proto3 JSON
  // rule) silently yields a 48-char / 24-char string of garbage instead.
  // Name and attributes survive that bug untouched, so only these catch it.
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
});

test('a malformed OTLP body returns 400 and does not crash the server', async () => {
  const endpoint = await traceReceiver.endpoint();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: Buffer.from([0x0b]), // unsupported wire type -- see otlp-decode.test.js
  });
  assert.strictEqual(res.status, 400);
});

test('a request to an unknown path is 404, not crashing or hanging', async () => {
  const endpoint = await traceReceiver.endpoint();
  const base = new URL(endpoint);
  const res = await fetch(`http://${base.host}/not-traces`, { method: 'POST', body: '{}' });
  assert.strictEqual(res.status, 404);
});
