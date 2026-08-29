# Node auto-tracing (opt-in, no user code changes)

**Date:** 2026-08-30
**Status:** Approved

## Goal

Let a Node.js function get real OpenTelemetry spans for common libraries
(HTTP calls, AWS SDK calls, common DB drivers) **without writing any OTel
SDK code in the handler** — the auto-instrumentation equivalent of the
manual setup `fixtures/typescript/otel-span` already demonstrates. This is
a deliberate extension of the invoke-tracing feature's original scope,
which explicitly listed "auto-instrumenting any handler language/runtime"
as a non-goal to keep v1 small — this spec picks that back up for Node
only, using a mechanism (wrap the process launch, never touch the user's
files) that keeps faith with the underlying principle that motivated the
original non-goal: the playground never modifies a user's project.

## Scope decisions

- **Node only.** Node and Java both have a clean "attach instrumentation
  before your code loads" mechanism (Node: `--require`; Java: a
  `-javaagent`). Python's equivalent (`opentelemetry-instrument`) needs the
  instrumentation packages installed in the *user's own* virtualenv, not
  just the playground's, so "automatic" breaks down there. `provided`
  (an arbitrary compiled binary/script) has no generic hook at all. Java is
  a plausible future follow-on with the same shape as this spec; Python and
  `provided` are out of scope indefinitely, not just for v1.
- **Opt-in per function**, not on by default — a new `autoTrace: boolean`
  field on `FunctionDef`, off unless explicitly turned on. Matches every
  other optional capability this project already has (`localServices`,
  `trigger`): the base invoke path doesn't change unless a function asks
  for it. Reasoning beyond consistency: `getNodeAutoInstrumentations()`
  patches a lot of libraries and adds real overhead per invoke, which
  shouldn't apply to every Node invocation whether or not anyone cares
  about tracing it.
- **A handler with its own OTel setup wins, full stop — auto-instrumentation
  is skipped entirely for that invoke, not layered on top.** This is not
  optional or best-effort: verified directly (see Detection below) that
  OTel's global tracer registration is strictly first-registration-wins,
  so if the playground's auto-tracing bootstrap ever registered a provider
  before the handler's own module loaded, the handler's own
  `trace.setGlobalTracerProvider(...)` call would be silently rejected —
  exactly backwards from "use what's already there." The fix is to decide
  *before spawning the process at all*, not to race at runtime.
- Auto-tracing produces spans through the exact same pipeline the rest of
  invoke-tracing already built — same `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  env var, same receiver, same collector, same Trace tab. Nothing about
  span capture, correlation, or display changes; this spec is purely about
  how spans get *created* without hand-written SDK code.
- **Only handlers Node loads as CommonJS actually get auto-traced.**
  Verified by hand: OTel's Node auto-instrumentation patches libraries by
  hooking CommonJS's `require()`; a handler loaded as a native ES module
  never goes through that hook, so it runs correctly but silently produces
  zero auto-instrumented spans — not an error, just an empty trace, the
  same "no tracing configured" outcome a handler with no OTel code at all
  already produces today. This is *not* about the handler's source
  language — every existing TypeScript fixture in this repo (including
  `otel-span`) is esbuild-bundled to CommonJS output by default (confirmed
  by reading the actual bundled `dist/index.js`: `require(...)` calls, not
  `import`), so bundled TS handlers are covered same as hand-written
  `.js`/`.cjs` ones. The gap is specifically: a `.mjs` handler, or a `.js`
  handler with `"type": "module"` in its `package.json`, invoked without a
  CJS-emitting build step. Documented plainly in the README rather than
  worked around — there is a general fix (Node's `module.register()` ESM
  loader hook, stable since Node 20.6, which this project's Node ≥22.12
  floor supports), but it adds real complexity and is left for a later
  iteration if the gap turns out to matter in practice.

## Detection: does this project already have its own tracing?

Before an invoke ever spawns a child process, if `opts.autoTrace` is true
and `opts.runtime === 'node'`, `server/invoker.js` reads the project's
`package.json` (from `opts.dir`) and checks `dependencies` and
`devDependencies` for any key starting with `@opentelemetry/sdk-trace`
(covers `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-trace-node`,
`@opentelemetry/sdk-trace-base` — every real entry point for "this project
sets up its own tracer provider"). A missing, unreadable, or malformed
`package.json` counts as "no existing tracing" (same permissive-default
posture `server/detect.js` already takes elsewhere in this codebase).

- **Found:** invoke exactly as today. No `--require` flag, no bootstrap, no
  behavior change whatsoever — the handler's own setup (like
  `otel-span`'s) runs untouched, exactly as it already does.
- **Not found:** inject the auto-tracing bootstrap (below).

This is a static, pre-flight check — not a runtime race, not a monkeypatch
of OTel's own registration internals (which would be fragile across
versions). One clean either/or, decided once per invoke, before anything
spawns.

New module `server/auto-trace-detect.js`, exporting
`hasOwnTracingSetup(projectDir) -> boolean`, so the detection logic has its
own testable unit separate from `invoker.js`'s control flow.

## The bootstrap

New file `harnesses/node/auto-trace-bootstrap.cjs` — a playground-owned
file, loaded via Node's `--require` flag, never copied into or referenced
from the user's project. **Must be `.cjs` (CommonJS), not `.mjs`** — verified
by hand: OTel's Node auto-instrumentation patches libraries by hooking
CommonJS's `require()` (via `require-in-the-middle`), which native ES
module `import` statements never go through at all. A `.cjs` bootstrap
loaded via `--require` patches `require()` globally regardless of the
bootstrap file's own module type, so this only affects the bootstrap
itself, not what it's able to intercept — see the handler-format
constraint below for the half that isn't fixable this way. It:

1. Registers `AsyncLocalStorageContextManager` (from
   `@opentelemetry/context-async-hooks`) as the global context manager —
   required for spans to nest correctly across `await` boundaries, the
   same gap already found and fixed by hand while building the
   `otel-span` fixture's multi-span pipeline.
2. Builds a `TracerProvider` the same way every manual example in this
   codebase already does: `resourceFromAttributes({...}).merge(detectResources({
   detectors: [envDetector] }))` for the resource (so
   `OTEL_RESOURCE_ATTRIBUTES`'s `faas.invocation_id` reaches the spans),
   `SimpleSpanProcessor(new OTLPTraceExporter())` reading the same
   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`_PROTOCOL` env vars `buildEnv`
   already injects for every invoke.
3. Registers `getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-dns':
   { enabled: false } })` via `@opentelemetry/instrumentation`'s
   `registerInstrumentations`. `@opentelemetry/instrumentation-fs` is
   already excluded by the package's own defaults (confirmed by reading
   its source: `defaultExcludedInstrumentations` includes `fs` and
   `host-metrics` already) — `dns` is not excluded by default and is
   disabled here explicitly, since it tends to add a low-value child span
   per outbound connection that duplicates what the parent HTTP span
   already shows. Everything else (`http`, `aws-sdk`, `pg`, `mysql2`,
   `ioredis`, `express`, etc.) stays at the package's own defaults.
4. Sets `globalThis.__awsPlaygroundFlushTracing = () => provider.forceFlush()`
   — see Flush below.

New dependency for the playground's own `package.json` (not the user's
project): `@opentelemetry/auto-instrumentations-node` (confirmed to exist,
current version `0.79.0`, pulls in ~40 individual per-library
instrumentation packages as its own dependencies — a real increase in the
playground's own install footprint, weighed against the alternative of
hand-maintaining a curated instrumentation list, which would need updating
every time a new library gets added to the ecosystem). `@opentelemetry/instrumentation`
(`registerInstrumentations`) is also needed directly.

## Command & env wiring

`server/invoker.js`'s `command(opts, harnessArgs)` currently returns
`{ cmd: process.execPath, args: [harnessPath, ...harnessArgs] }` for
`runtime === 'node'`. When auto-tracing applies for this invoke (opt-in
flag set, no existing tracing setup detected), the args array gains
`--require <absolute-path-to-auto-trace-bootstrap.cjs>` inserted **before**
the harness script path — Node only honors CLI flags positioned before the
script argument, so this ordering is load-bearing, not stylistic.
`invoke()` computes the detection result once, before calling `command()`,
and threads a boolean through so `command()` stays a pure function of its
inputs rather than reaching into the filesystem itself.

No changes to `buildEnv` — the bootstrap reads the exact same
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`_PROTOCOL`/`OTEL_RESOURCE_ATTRIBUTES`
vars every invoke already gets, whether or not auto-tracing is active.

## Flush

`harnesses/node/harness.mjs` calls `process.exit(0)` immediately after
writing its result file — the same reason the manual `otel-span` fixture
needs an explicit `await provider.forceFlush()` before returning applies
here too, except now it's the playground's own bootstrap's spans that need
flushing, not the user's. Since the user's handler code has no idea
auto-tracing exists, the harness itself takes responsibility: right before
`writeResult`/`process.exit(0)` (both the success and failure paths),
check for and `await` `globalThis.__awsPlaygroundFlushTracing?.()` if the
bootstrap defined it. When auto-tracing isn't active for this invoke
(no `--require`, bootstrap never loaded), the global is simply undefined
and the check is a no-op — zero behavior change for every invoke that
doesn't opt in.

## Toggle & UI

New `autoTrace: boolean` field on `FunctionDef`, added to `server/store.js`'s
`ALLOWED_KEYS` (same list `localServices`/`trigger` already live in) and
persisted the same way. A new small toggle component
(`web/src/components/auto-trace-toggle.tsx`), rendered in
`function-header.tsx` next to the existing `TriggerButton`, shown only when
`fn.runtime === 'node'` — flips `autoTrace` via the same `useUpdateFunction()`
PATCH pattern `LocalServiceToggles` already uses.

## Error handling & edge cases

- **`package.json` missing, unreadable, or has no `dependencies`/`devDependencies`
  object:** treated as "no existing tracing setup" — auto-tracing applies.
  Never throws; never blocks an invoke.
- **Handler is a native ES module** (`.mjs`, or `.js` with `"type": "module"`
  and no CJS-emitting build step): per the Scope decisions section above,
  produces zero auto-instrumented spans, not an error — indistinguishable
  in the Trace tab from a handler that never opted in at all. No detection
  or warning is added for this case in this iteration; it's documented in
  the README as a known boundary instead.
- **The auto-instrumentation bootstrap itself throws during module load**
  (a bad/incompatible library version, an unexpected environment): this
  would currently surface as a generic init failure for the whole invoke,
  same as any other module-load failure the harness already handles via
  its existing `catch` around handler resolution — no special-casing
  needed, since `--require` failures manifest as the Node process failing
  to start the same way a syntax error in the user's own handler would.
- **A function's `runtime` is changed away from `node` while `autoTrace`
  is still `true`:** the field is simply ignored for non-Node runtimes
  (checked at the `opts.runtime === 'node'` gate in `invoker.js`), same
  posture as `localServices` toggles that don't apply to every runtime
  either. The UI toggle itself is hidden for non-Node functions, so this
  is only reachable via direct API use, not the normal UI flow.
- **Detection false positive** (project declares `@opentelemetry/sdk-trace*`
  as a dependency but never actually calls `trace.setGlobalTracerProvider`):
  auto-tracing is skipped, the handler runs with no tracing at all — a
  known, accepted heuristic limitation, not a crash or a silent wrong
  answer. Documented in the README alongside the other tracing gotchas.

## New dependencies

`@opentelemetry/auto-instrumentations-node` (^0.79.0) and
`@opentelemetry/instrumentation` (^0.221.0) — both added to the
playground's own `package.json`, not the user's project, same boundary the
existing OTel test dependencies (`@opentelemetry/sdk-trace`,
`@opentelemetry/context-async-hooks`, etc., added while building the
original invoke-tracing feature) already respect.
`@opentelemetry/context-async-hooks` (already a dependency from the
`otel-span` fixture's own package.json, but needed here as a **playground**
dependency too, for the bootstrap's own context manager registration).

## Non-goals

- Python, Java, or `provided` auto-instrumentation (Java is a plausible
  same-shaped follow-on; Python and `provided` are not, per the Detection
  section's mechanism analysis above).
- Any UI surfacing of *which* instrumentations fired for a given invoke —
  spans from auto-instrumentation look identical to manually-created spans
  in the Trace tab, with no visual distinction. Adding one is a reasonable
  future enhancement, not required here.
- Runtime detection or racing with the handler's own OTel setup — the
  static pre-flight check is deliberately the only mechanism; no fallback
  path tries to be clever if the static check is wrong.
- Configuring which instrumentations are enabled from the UI — the
  curated default set (everything except `fs`/`dns`/`host-metrics`) is
  fixed for this iteration.

## Testing

- `tests/auto-trace-detect.test.js` (new): `hasOwnTracingSetup` returns
  `true` for a `package.json` with `@opentelemetry/sdk-trace-node` in
  `dependencies`, `true` for one in `devDependencies`, `false` for a
  project with only `@opentelemetry/api` (the API package alone doesn't
  mean tracing is configured), `false` for a missing/malformed
  `package.json`.
- `tests/invoker.test.js`: a case asserting that with `autoTrace: true`
  and no existing tracing dependency, the spawned Node command's `args`
  include `--require` pointed at the bootstrap file, positioned before the
  harness script path; a case asserting that with an existing
  `@opentelemetry/sdk-trace*` dependency present, no `--require` is added.
- A new fixture, `fixtures/javascript/auto-trace-http`: a plain
  hand-written CommonJS handler (`exports.handler = ...`, `require('http')`,
  matching `fixtures/javascript/hello`'s existing convention — no build
  step needed) with **no OTel code at all**, making one real outgoing
  `http` request to a local test server (mirroring `harness-node-s3.test.js`'s
  in-test HTTP stub pattern) — proving the auto-instrumentation path
  captures a real span for a library the handler never manually
  instrumented. Deliberately plain JavaScript, not a TypeScript+esbuild
  fixture, both because no build step is needed to demonstrate this and
  to keep the "which handlers actually get patched" story simple to read.
- An end-to-end test (`tests/harness-node-autotrace.test.js`, mirroring
  `tests/harness-node-otel.test.js`'s structure) spawning the real Node
  harness with `--require` against the real trace-receiver, asserting a
  real `http`-instrumentation-generated span round-trips correctly.
- Web: a small test for the new toggle component (renders only for
  `runtime === 'node'`, PATCHes `autoTrace` on click) and a
  `function-header.test.tsx` case confirming it's absent for non-Node
  functions.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`.
