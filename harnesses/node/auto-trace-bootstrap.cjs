// AWS Lambda Playground Node auto-tracing bootstrap. Loaded via --require
// when a function has autoTrace enabled and no tracing setup of its own
// (server/auto-trace-detect.js decides this once, before spawning, in
// server/invoker.js) -- never copied into or referenced by the user's
// project. Must stay .cjs: OTel's Node auto-instrumentation patches
// libraries by hooking CommonJS's require(), which a native ES module
// import statement never goes through -- verified by hand that an ESM
// handler produces zero spans regardless of what this file does, while a
// CJS (or CJS-bundled) handler is patched correctly either way.
const { context, trace } = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { detectResources, envDetector, resourceFromAttributes } = require('@opentelemetry/resources');
const { TracerProvider, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// Same merge() requirement as every manual example in this codebase -- a
// resource built from a plain attributes object does not pick up
// OTEL_RESOURCE_ATTRIBUTES on its own, only envDetector reads it.
const resource = resourceFromAttributes({ 'service.name': 'auto-traced-function' })
  .merge(detectResources({ detectors: [envDetector] }));

const provider = new TracerProvider({
  resource,
  spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter() })],
});
trace.setGlobalTracerProvider(provider);

// fs is already excluded by this package's own defaults; dns is not, and
// is disabled here since it tends to add a low-value child span per
// outbound connection that duplicates what the parent HTTP span already
// shows.
registerInstrumentations({
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-dns': { enabled: false },
  })],
});

// harnesses/node/harness.mjs calls this (if defined) right before writing
// its result file and exiting, since ending a span only starts its
// asynchronous export -- the same reason every manual example needs an
// explicit forceFlush(), except here it's the playground's own bootstrap
// doing it instead of the user's handler code.
globalThis.__awsPlaygroundFlushTracing = () => provider.forceFlush();
