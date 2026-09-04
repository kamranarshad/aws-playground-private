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
between resolving the handler (import, in Node's case) and invoking it —
`durationMs` in every harness today is already measured from *after* that
seam, i.e. handler-execution time only, matching what real Lambda's REPORT
line calls `Duration` (which likewise excludes init time). Nothing about
`durationMs` changes.

What's missing is the init side: each harness starts a second timer at
process start (right after arg parsing) and records how long it took to
reach the point where `durationMs`'s own timer starts (module import for
Node, `importlib.import_module` for Python, `Class.forName` for Java, first
`GET /invocation/next` poll for `provided`). That becomes a new `initMs`
field in the result-file envelope, reported only on the **success** path —
the existing failure-path envelopes already carry a `phase: 'init' |
'invoke'` distinction and don't need a numeric breakdown on top of it.

`server/invoker.js` reads `initMs` off the envelope the same way it reads
`durationMs` today and adds it to `report` unchanged; `report.durationMs`
and the existing top-line "OK · Xms" badge in `result-panel.tsx` are
unaffected. The Report tab gains an `Init Duration: X ms` line alongside the
existing `Duration:`/`Billed Duration:` lines, matching real Lambda's REPORT
line format — every playground invoke is a fresh process (the README's
"cold-start semantics" by design), so init is always meaningful here, unlike
real Lambda where it's usually omitted on warm invokes.

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
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<trace-receiver's endpoint()>
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_RESOURCE_ATTRIBUTES=faas.invocation_id=<requestId>
```

The signal-specific `_TRACES_ENDPOINT` var (not the generic
`OTEL_EXPORTER_OTLP_ENDPOINT`) is deliberate and load-bearing: per the OTel
spec (confirmed by reading `@opentelemetry/otlp-exporter-base`'s own env
resolution code), the generic var has `/v1/traces` **appended** to it by
the SDK, while the signal-specific var is used **verbatim**. Since
`endpoint()` already returns the full `.../v1/traces` URL, only the
signal-specific var is correct here — and since this receiver only ever
handles traces, using the signal-specific var also avoids implying metrics
or logs support that doesn't exist. These are standard OTel SDK env vars —
any handler that configures its tracer provider from env (the default
pattern for every language SDK) picks these up with zero
playground-specific code. A handler with no OTel SDK never touches them
and behaves exactly as it does today.

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

`invoker.js` does **not** block waiting for spans. Immediately after the
child process exits, it takes a snapshot of whatever is currently in the
buffer (usually empty — a span already in flight over the network when the
child died can still arrive after this point, which is exactly the case
this window exists for) and attaches it as `out.trace = { spans, pending:
true }`, then starts the countdown. `pending` always starts `true` and
flips to `false` only when the window closes — there's no cheaper "nothing
will ever arrive, skip the window" shortcut, since a zero-span snapshot at
this exact instant can't distinguish "no OTel SDK" from "OTel SDK whose
export request just hasn't landed yet." The cost of always opening the
window is trivial (one `Map` entry and one timer per invoke, both freed
within `AWS_PLAYGROUND_TRACE_WINDOW_MS`), and the web UI only polls for the
one invoke currently on screen, not every open window. This keeps the
existing synchronous invoke response time unaffected by tracing.

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
alongside Response/Logs/Report — always present, the same way those three
are, rather than conditionally shown like Checks/History. `trace` is
always populated (`{ spans: [], pending: false }` at minimum, per Span
Capture's Correlation window above), so there's no "has a trace vs.
doesn't" state to gate on the way there is for Checks (which genuinely
doesn't exist until a script runs) — the tab just shows its empty state for
the common case of a handler with no OTel SDK. Spans render as a flat list
ordered by start time, indented by `parentSpanId` depth, each row showing
name, duration, and key attributes. Empty state: "No spans received —
export to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` from your handler to see
spans here." No
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
- **Handler doesn't flush its span processor before returning**: verified
  empirically while writing this spec (ran a real `@opentelemetry/sdk-trace`
  + `@opentelemetry/exporter-trace-otlp-proto` handler through the real Node
  harness against a throwaway receiver) — without an explicit `await
  provider.forceFlush()` before the handler returns, **no span arrives at
  all**, even with `SimpleSpanProcessor`. Ending a span only *starts* its
  export; the actual HTTP POST is asynchronous I/O, and
  `process.exit(0)` (right after the harness writes its result-file) kills
  the process before that I/O completes, every time, regardless of
  processor type — `SimpleSpanProcessor` vs `BatchSpanProcessor` only
  changes how much gets buffered before an export starts, not whether the
  export's completion is awaited. This mirrors the real constraint AWS's
  own OTel Lambda layer works around by forcing a flush on invoke-complete
  — not something the playground papers over. Documented in the Trace
  tab's empty state and README: call `forceFlush()` (or `shutdown()`)
  before returning, unconditionally.
- **Handler builds its own `Resource` without env detection**: also
  verified empirically — a `Resource` built via `resourceFromAttributes({
  ... })` alone does **not** pick up `OTEL_RESOURCE_ATTRIBUTES`; only
  `@opentelemetry/resources`' `envDetector` reads that env var, and it must
  be explicitly merged in (`resourceFromAttributes({...}).merge(detectResources({
  detectors: [envDetector] }))`) for the `faas.invocation_id` correlation
  attribute to reach the span at all. `@opentelemetry/sdk-node`'s `NodeSDK`
  (the higher-level, commonly-recommended entry point) includes
  `envDetector` in its resource detectors by default, so this only bites
  handlers that hand-rolled a lower-level `TracerProvider` setup — also
  documented in the README/empty-state alongside the flush requirement.
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
- **Phase timing on init failure**: unaffected — `initMs` is only reported
  on the success path; existing failure-path `phase` values and shapes are
  unchanged.

## New dependencies

None. The obvious candidate, `@opentelemetry/otlp-transformer` (the
official OTel JS package), was checked directly against its published
`.d.ts` and turns out to only implement the **exporter** side —
`ProtobufTraceSerializer`/`JsonTraceSerializer` each expose
`serializeRequest(spans: ReadableSpan[])` and `deserializeResponse(bytes)`,
with no supported way to decode an incoming `ExportTraceServiceRequest`.
There's no other package purpose-built for the receiving side either.

Instead, `server/otlp-decode.js` hand-decodes exactly the OTLP messages
this playground needs — `ExportTraceServiceRequest` → `ResourceSpans` →
`ScopeSpans` → `Span`, plus the common `KeyValue`/`AnyValue`/`Resource`
types — against the fixed, versioned
[opentelemetry-proto schema](https://github.com/open-telemetry/opentelemetry-proto)
(field numbers confirmed directly from that repo's `.proto` sources). This
is a small, self-contained wire-format reader (varint + length-delimited
parsing over a fixed set of known field numbers), in the same spirit as
the `provided` harness hand-implementing the Lambda Runtime API instead of
depending on a package. JSON-encoded OTLP bodies need no library at all —
just `JSON.parse` plus reading the proto3 JSON mapping's field names
(base64 for `bytes`, decimal strings for 64-bit ints).

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
  `tests/java.test.js`, `tests/harness-provided.test.js`): success-path
  envelopes include a new `initMs` alongside the existing `durationMs`;
  failure-path envelopes unchanged.
- `tests/trace-collector.test.js` (new): window-open buffering, merge on
  each incoming batch, drop-after-close, `pending` flag transitions.
- `tests/otlp-decode.test.js` (new): a small test-only protobuf encoder
  (mirroring the production decoder's field numbers) round-trips a
  resource + span through `decodeProtobuf`; a hand-written JSON fixture
  round-trips through `decodeJson`; both produce the same normalized shape.
- `tests/trace-receiver.test.js` (new): posts real OTLP requests — built
  with the actual `@opentelemetry/exporter-trace-otlp-proto` /
  `-otlp-http` exporters pointed at the receiver's own `endpoint()`, not
  hand-built bytes — and asserts correlation by `faas.invocation_id` groups
  correctly; a malformed body returns `400`.
- `tests/history.test.js`: `appendSpans` merges into an existing JSONL entry
  and updates `pending`.
- End-to-end: a new `fixtures/typescript/otel-span` fixture, its committed
  `dist/index.js` bundled the same way `fixtures/typescript/node-s3` is
  (own `package.json`, `npm install && npm run build` run once and the
  output committed, tests skipped if `dist/` is missing). Its handler
  builds a `TracerProvider` with a merged env-detected `Resource` (per the
  gotcha above) and a `SimpleSpanProcessor`, creates one span, and calls
  `await provider.forceFlush()` before returning — the exact shape verified
  by hand while writing this spec. The test asserts the span round-trips
  into the invoke result via the real `/v1/traces` route end to end.
- Web: `result-panel.test.tsx` gains Trace tab cases — empty state, span
  list rendering with parent/child indentation, polling while `pending` is
  true and stopping once it flips to false.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`.
