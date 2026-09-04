# Architecture overhaul: warm execution environments, unified contracts, workspace layout

**Date:** 2026-08-31
**Status:** Approved

## Goal

Eight improvements identified in a full-codebase review, delivered as one
program of work on a single branch merged locally into `develop`. Seven are
structural — they change how the code is organised, typed and packaged
without changing what the tool does. One (warm execution environments) is a
genuine feature that changes observable invoke behaviour and closes the
largest remaining fidelity gap with real Lambda.

The structural seven are sequenced *before* the feature so that it lands on
settled foundations rather than fighting a moving target.

## Scope decisions

- **All four runtimes get warm reuse.** Node, Python, Java and `provided`.
  This deliberately differs from how `autoTrace` shipped (Node-only, with
  Python and `provided` ruled out indefinitely) because the constraint that
  forced that decision does not apply here. Auto-tracing needed a
  language-specific "attach instrumentation before user code loads" hook,
  which Python and `provided` genuinely lack. A warm environment needs only
  a loop around the existing invoke and a socket, which every runtime in
  scope can do. There is no runtime here where the mechanism breaks down.
- **Warm by default, with an explicit force-cold escape hatch.** Real Lambda
  reuses execution environments by default; a playground that always cold
  starts cannot reproduce the single most common class of "works once, fails
  the second time" bug, which is exactly what a local playground exists to
  catch. Making it opt-in would leave the default unfaithful and the feature
  largely unused. The cost — changed observable behaviour for every existing
  function — is accepted and mitigated by a visible cold/warm badge.
- **Source edits always win over warm reuse.** This is the one place the
  design knowingly breaks fidelity with Lambda; see "Staleness" below. It is
  not negotiable: a playground that runs your old code after you saved is
  broken, whatever the semantics of the real service.
- **The server stays dependency-free.** Schema unification is hand-rolled
  rather than reaching for `zod`. The server currently has zero runtime
  dependencies (only `optionalDependencies` for the AWS SDK and OTel), the
  schema in question is small and closed, and the codebase already has an
  established validation idiom to follow. Adding a validation library to
  gain `infer` would trade a real property of the project for a convenience.
- **Full npm workspaces**, not a lighter typed-boundary cleanup. Chosen with
  the packaging risk understood and explicitly budgeted for (see "Risks").

---

## Part 1 — Warm execution environments

### Why

`server/invoker.js` spawns a fresh child process per invoke and reports
`initMs` every single time. Real Lambda reuses an execution environment:
module-scope state, `/tmp` contents, and connection pools survive across
invokes, and a warm invoke has no init phase at all.

Everything a user would use a local playground to discover about
environment reuse — the mutated global that breaks invoke #2, the handler
that is slow only because it reconnects to Postgres every time, the file
written to `/tmp` that unexpectedly persists — is invisible today.

### Pool key

An environment is identified by a hash over everything that would change
handler behaviour:

    functionId + runtime + dir + handler + resolved env + memoryMb
      + jarPath + autoTrace

Any change produces a different key, which evicts the old environment and
cold starts. `timeoutMs` is deliberately excluded: timeout is enforced
per-invoke by the parent process, not baked into the child, so changing it
does not require a new environment.

### Control channel

The current protocol — write the event to stdin, have the child write a
result file and exit — cannot survive a second invoke. A replacement has to
carry framed request/response traffic, and it cannot use stdout or stderr,
because those *are* the logs.

Extra file descriptors (the usual answer) are ruled out by Java being in
scope: a JVM cannot portably reach an inherited fd 3.

**Design:** one shared control server per playground process, listening on
loopback. Each harness receives `AWS_PLAYGROUND_CONTROL_ADDR` and
`AWS_PLAYGROUND_ENV_ID` in its environment, connects on boot, identifies
itself once, then serves a request loop. Messages are length-prefixed JSON.

    child → { type: 'hello', envId }
    parent → { requestId, event, deadlineMs }
    child → { requestId, ok, response | error, initMs?, durationMs }

One server rather than one listener per environment: N ephemeral listeners
would be N sockets and N ports for no benefit, and the `envId` handshake
gives the parent everything it needs to correlate.

`initMs` is present on the first response from an environment and absent on
every subsequent one. That single field is the entire cold/warm
distinction, and it is what the UI badge reads.

### Log attribution

Logs stream continuously on stdout/stderr while control traffic flows over a
socket. Two independent channels means a response can arrive before the last
log bytes have been delivered — so "read the logs when the response lands"
silently truncates output under load.

Rather than paper over this with a drain timer (a guess that fails on a slow
machine), the harness flushes its streams and writes a NUL-delimited
sentinel to stdout before replying:

    \0AWSPLAY-END:<requestId>\0

The parent accumulates log output and cuts at the sentinel, stripping it.
NUL delimiters plus a UUID make collision with real handler output
implausible, and the result is deterministic rather than timing-dependent.

**Accepted behaviour:** a handler that logs *after* returning — a stray
`setTimeout`, an unawaited promise — has that output attributed to the
*next* invoke. This is not a defect to fix. It is precisely what real
Lambda does, and reproducing it is the point.

### Eviction

An environment is destroyed when any of these happen:

- **Idle timeout.** Default 5 minutes, overridable via
  `AWS_PLAYGROUND_WARM_IDLE_MS`, following the existing `graceMs()` pattern
  in `services/lifecycle.js`.
- **Config change.** Any input to the pool key changes.
- **Timeout.** A timed-out invoke kills the process group and discards the
  environment — matching Lambda, where a timeout destroys the environment.
- **Crash.** Non-zero exit or a dropped control socket.
- **Build.** Any run of `fn.buildCommand`, which by definition changed the
  artifacts the environment loaded.

### Staleness — the deliberate deviation

Real Lambda has no notion of the code changing under a warm environment;
a deploy creates a new one. Locally, the source changes constantly, and an
environment holding a previous version of the handler would make the tool
actively wrong.

**Design:** recursive `fs.watch` on the project directory, ignoring paths
containing `node_modules`, debounced, evicting the environment on any
change.

Where a recursive watch cannot be established — an unsupported platform, a
descriptor limit, a directory that disappears — the environment is flagged
unwatchable and evicted after **every** invoke. That degrades exactly to
today's always-cold behaviour: slower, never stale. The failure mode of this
subsystem is "no faster than before", never "ran your old code".

### Visibility and control

Warm-by-default is invisible without deliberate surfacing, and invisible
state is confusing state:

- A **cold/warm badge** on the Report tab, derived from the presence of
  `initMs`.
- A **force-cold control** in the function header, next to the existing
  invoke affordances, that evicts the environment before the next invoke.
  Also available as `forceCold: true` on the invoke payload, which is what
  the control sends.

### Interaction with existing machinery

The `inFlight` one-invoke-per-function guard is unchanged, so an environment
never handles two concurrent requests and the log-sentinel scheme never has
to disambiguate interleaved output. Pool shutdown joins the SIGINT/SIGTERM
sweep in the new `server/bootstrap.js` (Part 5), alongside the existing
trigger and container teardown.

### Testing

The pool is an explicit, injectable component rather than ambient module
state, so tests opt out of warm behaviour deliberately instead of
discovering it by accident. Both paths are exercised directly: that a second
invoke reuses module scope and reports no `initMs`, and that each eviction
trigger above actually produces a cold start.

---

## Part 2 — Atomic persistence writes

`server/store.js:41` and `server/history.js:63` both overwrite live files
with a bare `writeFileSync`. A crash or a full disk mid-write truncates the
user's function registry.

The evidence this has already bitten: `store.load()` carries an elaborate
recovery path that quarantines an unparseable `functions.json` as
`.corrupt` and starts empty. That treats the symptom.

**Design:** write to a sibling temp file and `renameSync` over the target —
atomic within a filesystem. The quarantine path stays as a backstop for
damage from outside this process, but stops being reachable by our own
writes. History compaction gets the same treatment; today an interrupted
compaction loses the whole file rather than one entry.

## Part 3 — Unified schema and types

The same trigger shape is specified three times: `triggerError()` in
`server/api/functions.js`, `parseTrigger()` in `server/projectconfig.js`,
and the `FunctionTrigger` union in `web/src/lib/types.ts`. They have already
drifted and been re-synced — the S3 dedup comment is copy-pasted verbatim
across both server files because the same bug had to be fixed twice. Adding
a trigger type today means editing three files plus `ALLOWED_KEYS` and the
defaults in `store.create`.

**Design:** `server/schema/` owns defaults, allowed keys, and validation.
The two server call sites need genuinely different semantics — the API
returns a human-readable error string, while `playground.json` silently
ignores invalid values — so the module exports one core validator with two
thin adapters rather than pretending the semantics are the same.

`server/types.d.ts` becomes the single type source. With workspaces
(Part 6), the web app imports it and the duplicated definitions in
`web/src/lib/types.ts` are deleted.

## Part 4 — Ports in one place

`9500` (HTTP trigger), `9501` (S3 webhook) and `9400`–`9404` (services) are
literals spread across three modules, including inside a docker `-e` string
that hardcodes the S3 webhook port into MinIO's configuration — coupling the
service registry to a trigger module's private constant.

Worst of all, `web/src/lib/http.ts:1` duplicates `9500` across the language
boundary with only a comment (`must match server/trigger/http.js's PORT`)
holding it in sync.

**Design:** `server/ports.js` as the single source; `services/registry.js`
composes its `runArgs` from it; `/api/health` exposes the map; the web
reads ports from the health query it already issues, and the comment
becomes unnecessary.

## Part 5 — Bootstrap extraction

`bin/cli.js` is the only thing that resumes triggers, starts the S3
listener, and installs the shutdown sweep. `npm run dev` therefore serves a
working UI and API with **no triggers firing, no S3 listener bound, and no
container reaping on exit** — so a contributor developing a trigger feature
cannot use the dev server to do it.

**Design:** `server/bootstrap.js` exposing idempotent `start()` / `stop()`,
called by both `bin/cli.js` and the dev path. The warm-environment pool
(Part 1) registers its teardown here too.

## Part 6 — Layout and packaging

**Module layout.** `api/`, `services/` and `trigger/` are properly grouped;
the fourteen files left at `server/`'s root are four unrelated concerns
sharing a drawer. They become `server/runtime/` (invoker, pool, control,
build, detect, envfile, node-version), `server/trace/` (receiver, collector,
otlp-decode, auto-trace-detect), `server/persistence/` (store, history,
projectconfig) and `server/schema/`.

`server/trigger/s3.js` (336 lines) is four things — a webhook listener,
event normalisation, bucket-notification configuration, and driver state —
and becomes a directory with those as separate modules.

`invokeFunction` in `server/api/invoke.js` is a 100-line pipeline that
hand-builds the same error envelope three times; its stages are extracted
and the envelope construction shared.

**Workspaces.** `server/` becomes a real package — `@aws-playground/server`,
private, with an `exports` map and `types` — declared in the root
`package.json`'s `workspaces` array alongside `web`.
`web/src/lib/backend.ts` then loses `createRequire`, the eight-level
directory walk that hunts for `server/api/index.js`, the recursive
`stat`-every-file-on-every-request dev cache-buster, and all three
`any` escapes — roughly eighty lines of compensation for `server/` not
being a package.

## Part 7 — Tests, artifacts, documentation

**Tests.** Thirty-nine files sit flat in `tests/` and run fully serially
under `--test-concurrency=1`, though only some genuinely need it (shared
`AWS_PLAYGROUND_DATA_DIR`, real ports, docker). They split into
`tests/unit/` (parallel) and `tests/integration/` (serial), mirroring the
new server layout.

**Committed build artifacts.** `harnesses/java/harness.jar` and the fixture
`dist/` and `target/` outputs are checked in. `harnesses/java/build.sh`
already exists. They become gitignored and built during `prepare`, skipping
gracefully with a clear message when the toolchain is absent — the same way
the tests already skip. The npm tarball must still *ship* the jar, since
users are not expected to have a JDK; only the git-tracked copy goes away.

**Documentation.** `README.md` is 21KB in one file and `docs/` has no
`ARCHITECTURE.md`, so the in-process CJS-backend design and the trigger
driver contract are explained only in scattered code comments.

---

## Risks

**Packaging is the sharp edge of this program.** Workspaces changes
`npm install` semantics; `prepare.js` currently strips `npm_config_omit`
specifically to stop the root's `--omit=optional` from breaking web's build;
and un-committing the jar adds a build step to a path that previously had
none. Together these give the `npx github:` install flow several
independent ways to regress, none of which the unit tests would catch.

`tests/pack.test.js` and `tests/prepare.test.js` exist and will be extended,
but the acceptance check is a real clean clone and a real `npm pack`, not a
passing refactor.

**Warm-by-default changes existing test assumptions.** Anything calling
`invoker.invoke()` directly now pools. Handled by making the pool explicit
and injectable (Part 1), so opting out is deliberate.

**This is a large diff on one branch,** by choice. The sequencing —
correctness, then contracts, then structure, then the feature — is what
keeps it reviewable: each phase lands on a settled base rather than
churning files a later phase is still editing.

## Non-goals

- Lambda's *concurrency* model. The `inFlight` guard keeps one invoke per
  function; warm environments do not introduce a multi-environment pool per
  function.
- Batch sizes above one for the SQS and DynamoDB pollers. Real Lambda
  batches; that is a separate change with its own event-shape implications.
- Splitting `README.md`. An `ARCHITECTURE.md` is added; restructuring the
  user-facing README is not part of this work.
