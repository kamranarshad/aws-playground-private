# Invoke tracing (phase timing + OTLP span capture)

**Date:** 2026-08-27
**Status:** Approved

## Goal

Surface where time goes during an invoke, at two levels of detail:

1. **Phase timing** — split the single `durationMs` the playground already
   reports into init (module resolve/import) vs. handler execution, the way
   real Lambda's cold-start REPORT line does.
2. **Span capture** — if a handler is instrumented with an OpenTelemetry SDK
   (the common modern choice for Lambda tracing, alongside/instead of
   X-Ray), let it export real spans to the playground and view them per
   invoke, without the playground doing any auto-instrumentation itself.

Both are additive to the existing invoke envelope (`response`/`logs`/`report`
today) and the existing History tab — no new invoke flow, no new port.

## Scope decisions

- Phase timing needs no opt-in — every harness already straddles an
  init/handler boundary, it's just not reported for the success path today.
- Span capture is opt-in by the handler's own code (add an OTel SDK,
  configure it from env — standard OTel behavior, not playground-specific
  API). The playground never injects instrumentation into a handler.
- OTLP over HTTP only (no gRPC) — accepting both `application/x-protobuf`
  and `application/json` bodies on one route, since real OTel SDKs default
  to protobuf but some configurations use JSON. Served from its own small
  loopback-only listener, separate from the main web server's port (see
  Receiver below for why).
- Trace data is persisted with history, like `logs`/`report` today, subject
  to the same `capJson` 64KB-per-field cap.
- Spans that arrive after the invoke's HTTP response has already gone out
  (a real possibility — exporters batch/flush asynchronously) still get
  merged into that invoke's history entry for a bounded window, and the web
  UI picks them up by polling while that window is open. Non-goal: spans
  arriving after the window closes are dropped, not queued indefinitely.

## Phase timing

Each harness (`harnesses/node/harness.mjs`, `python/harness.py`,
`java/Harness.java`, `provided/harness.mjs`) already has a natural seam
between resolving the handler (import, in Node's case) and invoking it. Each
harness starts timing at process start (after arg parsing), records `initMs`
right before calling the handler, then records `invokeMs` after the handler
settles. Both go into the result-file envelope on the **success** path (the
existing failure-path envelopes already carry a `phase: 'init' | 'invoke'`
distinction and don't need this — a failed invoke doesn't have a meaningful
handler-duration split).

`server/invoker.js` reads `initMs`/`invokeMs` off the envelope the same way
it reads today's `durationMs`; `report.durationMs` continues to mean total
time (now `initMs + invokeMs`) so the existing top-line badge in
`result-panel.tsx` is unaffected. `report` gains `initMs`, and the Report tab
gains an `Init Duration: X ms` line, matching real Lambda's REPORT line
format when cold-start tracing is visible.

No new dependencies, no new failure modes — this is a data plumbing change
inside envelopes that already exist.

## Span capture

### Receiver

The playground's web server doesn't have one consistently-discoverable port
to hand out: production (`bin/cli.js` + `serve-web.js`) picks one at
startup, but dev mode runs entirely inside `vite dev` (no `bin/cli.js`
involved), and trigger-invoked calls run with no incoming HTTP request to
read a host from. Rather than thread a port through every call site, span
ingestion gets its own tiny dedicated loopback HTTP server, following the
same pattern `harnesses/provided/harness.mjs` already uses for its Runtime
API emulation: `server.listen(0, '127.0.0.1', ...)`, then read back the
OS-assigned port from `server.address().port`.

New module `server/trace-receiver.js`: starts this listener once per
process (module-load time — one extra always-on tiny HTTP server per
playground process, negligible cost, no lazy-init races between concurrent
invokes), exposes `endpoint()` returning `http://127.0.0.1:<port>/v1/traces`
and `close()` for test teardown. Bound to `127.0.0.1` only, so it's
unreachable from outside the machine the same way every other playground
listener is — no separate Host-header check needed since nothing but
loopback can reach it.

The route handler:
1. Reads `content-type`; decodes the body as OTLP protobuf
   (`ExportTraceServiceRequest`) or OTLP/JSON accordingly. A malformed or
   undecodable body gets a `400` response and is dropped — matches how a
   real OTLP collector behaves, and doesn't touch any in-flight invoke.
2. Extracts each span's resource attributes, groups by `faas.invocation_id`.
3. Pushes each group into `traceCollector` (new module,
   `server/trace-collector.js`), an in-memory `Map<requestId, { spans: [],
   closesAt: number }>`.

### Env injection

`server/invoker.js`'s `buildEnv()` adds three env vars to every invoke,
alongside the existing `AWS_LAMBDA_*` set:

```
OTEL_EXPORTER_OTLP_ENDPOINT=<trace-receiver's endpoint()>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_RESOURCE_ATTRIBUTES=faas.invocation_id=<requestId>
```

These are the standard OTel SDK env vars — any handler that configures its
tracer provider from env (the default pattern for every language SDK) picks
these up with zero playground-specific code. A handler with no OTel SDK
never touches them and behaves exactly as it does today.

### Correlation window

`traceCollector` opens an open-ended buffer (`{ spans: [], closesAt: null }`)
for a `requestId` the moment `invoke()` starts, so spans that arrive while
the child is still running have somewhere to land — no eviction timer runs
yet. When the child process exits, `invoker.js` tells `traceCollector` to
start the countdown: `closesAt = now + windowMs`
(`AWS_PLAYGROUND_TRACE_WINDOW_MS`, default 10s — configurable the same way
`AWS_PLAYGROUND_HISTORY_COMPACT_BYTES` already is). Any span for that
`requestId` arriving before `closesAt` is appended to the buffer. Once
`closesAt` passes, the buffer is deleted — later stragglers for that
`requestId` are dropped silently (no unbounded memory growth, no reopening
a closed window).

`invoker.js` does **not** block waiting for spans. It reads back whatever is
currently in the buffer immediately after the child process exits and
attaches it as `out.trace = { spans, pending: true }` if the window is still
open, or `{ spans, pending: false }` if there was never any span for this
`requestId` and nothing to wait for. This keeps the existing synchronous
invoke response time unaffected by tracing.

### Persisting late arrivals

`server/history.js` gains `appendSpans(functionId, requestId, spans)`:
finds the matching entry in that function's JSONL file (by
`report.requestId`), merges the new spans into its `trace.spans`, rewrites
the file — reusing the existing `readAll`/`writeAll` pair, same cost model
as the existing overflow-compaction write. `traceCollector` calls this once
per incoming span batch while a requestId's window is open, and once more
with `trace.pending = false` when the window closes (so the persisted entry
stops advertising more data is coming).

### Web UI

New "Trace" tab in `ResultPanel` (`web/src/components/result-panel.tsx`),
alongside Response/Logs/Report/Checks/History — only shown when
`result?.trace` is present. Spans render as a flat list ordered by start
time, indented by `parentSpanId` depth, each row showing name, duration, and
key attributes. Empty state: "No spans received — export to
`OTEL_EXPORTER_OTLP_ENDPOINT` from your handler to see spans here." No
waterfall/timeline visualization in this iteration.

While the currently-displayed invoke's `trace.pending` is `true`, the web
UI polls that invoke's history entry (same `refetchInterval` idiom already
used for service status in `web/src/lib/queries.ts`) every ~1-2s, stopping
as soon as `pending` flips to `false`. Older invokes (not the one just run)
never poll.

## Error handling & edge cases

- **No OTel SDK in the handler**: no POSTs ever arrive; `trace = { spans:
  [], pending: false }`; empty state shown. Zero behavior change for the
  common case.
- **Handler doesn't flush its span processor before returning**: spans sit
  in the SDK's internal batch buffer and are lost when the child process
  exits (`process.exit(0)` right after the harness writes its result-file).
  This mirrors the real constraint AWS's own OTel Lambda layer works around
  by forcing a flush on invoke-complete — not something the playground
  papers over. Documented in the Trace tab's empty state and README rather
  than worked around by, e.g., delaying process exit.
- **Malformed OTLP payload**: `400`, payload dropped, no effect on any
  invoke in flight.
- **Spans for an unknown or already-closed `requestId`**: dropped silently
  server-side.
- **Non-localhost POSTs to `/v1/traces`**: not reachable at all — the trace
  receiver binds `127.0.0.1` only, like every other loopback listener this
  project already runs (e.g. the `provided` harness's Runtime API server).
- **History growth**: `trace` goes through the existing `capJson` truncation
  like `report`/`response` — a very chatty handler's spans get truncated at
  the existing 64KB-per-field cap, not left unbounded.
- **Phase timing on init failure**: unaffected — `initMs`/`invokeMs` are
  only reported on the success path; existing failure-path `phase` values
  and shapes are unchanged.

## New dependencies

A protobuf decoder for `ExportTraceServiceRequest` (OTLP's trace export
message), added to the playground server's own `package.json` — not
installed into or required by the user's project, same boundary the
existing AWS SDK client dependencies for triggers already respect.

## Non-goals

- Auto-instrumenting any handler language/runtime — the playground never
  adds tracing code to user projects.
- X-Ray / UDP daemon emulation (a natural future extension, not this spec).
- gRPC OTLP transport.
- A waterfall/timeline visualization — v1 is a flat, indented span list.
- Cross-invoke or cross-function trace correlation — one `requestId` maps to
  one invoke's spans only.
- Unbounded span retention — the correlation window and `capJson` cap both
  exist specifically to bound this.

## Testing

- Harness tests (`tests/harness-node.test.js`, `tests/harness-python.test.js`,
  `tests/java.test.js`): success-path envelopes include `initMs`/`invokeMs`
  summing to roughly `durationMs`; failure-path envelopes unchanged.
- `tests/trace-collector.test.js` (new): window-open buffering, merge on
  each incoming batch, drop-after-close, `pending` flag transitions.
- `tests/api-traces.test.js` (new): `/v1/traces` decodes a hand-built OTLP
  protobuf payload and an OTLP/JSON payload equivalently; malformed body
  returns `400`; correlation by `faas.invocation_id` groups correctly.
- `tests/history.test.js`: `appendSpans` merges into an existing JSONL entry
  and updates `pending`.
- End-to-end: a fixture handler (small addition under `fixtures/`) using a
  minimal OTel SDK setup that creates and flushes one span, asserting it
  round-trips into the invoke result via the real `/v1/traces` route.
- Web: `result-panel.test.tsx` gains Trace tab cases — empty state, span
  list rendering with parent/child indentation, polling while `pending` is
  true and stopping once it flips to false.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`.
