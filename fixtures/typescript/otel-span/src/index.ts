// Sample TypeScript Node lambda demonstrating OpenTelemetry span capture in
// aws-playground: register this folder with runtime `node`, handler
// `dist/index.handler`, and the playground's injected
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/OTEL_RESOURCE_ATTRIBUTES env vars are
// picked up automatically -- open the Trace tab after invoking to see the
// captured span.
import { trace } from '@opentelemetry/api'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { TracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

// merge(), not resource: alone -- a resource built from a plain attributes
// object does not pick up OTEL_RESOURCE_ATTRIBUTES on its own; only
// envDetector reads it, so the two need to be combined for the
// playground's per-invoke correlation attribute to reach the span.
const resource = resourceFromAttributes({ 'service.name': 'otel-span-fixture' })
  .merge(detectResources({ detectors: [envDetector] }))

const provider = new TracerProvider({
  resource,
  spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter() })],
})
trace.setGlobalTracerProvider(provider)
const tracer = trace.getTracer('otel-span-fixture')

export const handler = async (event: { name?: string }) => {
  const span = tracer.startSpan('do-work')
  span.setAttribute('event.name', event.name ?? 'world')
  await new Promise((resolve) => setTimeout(resolve, 5))
  span.end()
  // Ending a span only starts its export -- the actual HTTP POST is async
  // I/O that won't finish before this process exits unless it's awaited
  // here, regardless of processor type.
  await provider.forceFlush()
  return { ok: true, greeting: `hello, ${event.name ?? 'world'}` }
}
