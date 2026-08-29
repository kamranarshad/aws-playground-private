// Sample TypeScript Node lambda demonstrating OpenTelemetry span capture in
// aws-playground: register this folder with runtime `node`, handler
// `dist/index.handler`, and the playground's injected
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/OTEL_RESOURCE_ATTRIBUTES env vars are
// picked up automatically -- open the Trace tab after invoking to see the
// captured spans (try both the List and Timeline views).
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { TracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

// Without this, startActiveSpan's context doesn't survive an `await` --
// every span in the pipeline below would come back as a sibling with no
// parentSpanId instead of properly nested, since @opentelemetry/sdk-trace
// (unlike the Node-specific sdk-trace-node) doesn't register one for you.
// Verified by hand: nested spans had parentSpanId: undefined without this.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface UserRecord {
  id: number
  name: string
}

// A small, realistic-looking request pipeline -- validate, fetch (with a
// nested "query the database" child of its own), then build the response
// -- so the Trace tab's List and Timeline views have real hierarchy and
// overlapping/sequential timing to show, not just one flat span.
export const handler = async (event: { name?: string }) => {
  return tracer.startActiveSpan('handle-request', async (rootSpan) => {
    try {
      rootSpan.setAttribute('event.name', event.name ?? 'world')

      await tracer.startActiveSpan('validate-input', async (span) => {
        span.setAttribute('input.valid', true)
        await sleep(2)
        span.end()
      })

      const user = await tracer.startActiveSpan('fetch-data', async (span) => {
        span.setAttribute('data.source', 'users-table')
        const record = await tracer.startActiveSpan('db-query', async (dbSpan) => {
          dbSpan.setAttribute('db.system', 'postgresql')
          dbSpan.setAttribute('db.statement', 'SELECT * FROM users WHERE name = $1')
          await sleep(10)
          dbSpan.end()
          const result: UserRecord = { id: 1, name: event.name ?? 'world' }
          return result
        })
        await sleep(5)
        span.end()
        return record
      })

      const body = await tracer.startActiveSpan('build-response', async (span) => {
        const response = { ok: true, greeting: `hello, ${user.name}` }
        span.setAttribute('response.size_bytes', JSON.stringify(response).length)
        await sleep(3)
        span.end()
        return response
      })

      return body
    } finally {
      rootSpan.end()
      // Ending a span only starts its export -- the actual HTTP POST is
      // async I/O that won't finish before this process exits unless it's
      // awaited here, regardless of processor type.
      await provider.forceFlush()
    }
  })
}
