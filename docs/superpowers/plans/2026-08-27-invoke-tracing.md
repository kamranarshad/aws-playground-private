# Invoke Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add init/handler phase timing to every invoke's Report tab, and let handlers instrumented with an OpenTelemetry SDK export real spans to a new Trace tab, via a local OTLP/HTTP receiver — all opt-in on the handler's side, no playground-side auto-instrumentation.

**Architecture:** Each language harness gains an `initMs` field in its success envelope (durationMs already means handler-only time and is unchanged). A new always-on, loopback-only HTTP server (`server/trace-receiver.js`) accepts OTLP/HTTP span exports (protobuf or JSON, decoded by a small hand-rolled `server/otlp-decode.js` — no library implements OTLP request decoding), correlates spans to an invoke via a `faas.invocation_id` resource attribute injected through env vars, and buffers them in `server/trace-collector.js` for a bounded window after the invoke completes (since exporters flush asynchronously and can finish after the response already went out). Everything flows through the existing `report`/`history` envelope and JSONL storage; the web UI polls only the currently-displayed invoke while its trace is still "pending".

**Tech Stack:** Node.js (server + all harness-invocation plumbing), Python/Java (their own harnesses), React + TanStack Start + React Query (web UI). No new runtime dependencies — verified against the actual `@opentelemetry/otlp-transformer` package that it only implements the exporter side, not request decoding.

**Spec:** `docs/superpowers/specs/2026-08-27-invoke-tracing-design.md`

## Global Constraints

- The trace receiver binds `127.0.0.1` only — never `0.0.0.0` — matching every other loopback listener in this codebase (e.g. `harnesses/provided/harness.mjs`'s Runtime API server).
- No comments explaining *what* code does — only *why*, and only when non-obvious (matches this codebase's existing style throughout).
- `initMs` is reported only on the success path of each harness; failure-path envelopes (`phase: 'init' | 'invoke'`) are unchanged.
- The env vars injected into every invoke are `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` — the **signal-specific** vars, not the generic `OTEL_EXPORTER_OTLP_ENDPOINT` (which gets `/v1/traces` auto-appended by OTel SDKs and would double up with the receiver's own `/v1/traces` path).
- `AWS_PLAYGROUND_TRACE_WINDOW_MS` (default `10000`) controls how long the trace receiver keeps accepting spans for a finished invoke, following the same env-override pattern as `AWS_PLAYGROUND_HISTORY_COMPACT_BYTES` in `server/history.js`.
- Trace data is capped by the existing `capJson` 64KB-per-field limit in `server/history.js` — no separate size limit is introduced.

---

## Task 1: Node harness `initMs` + report/UI plumbing

**Files:**
- Modify: `harnesses/node/harness.mjs`
- Modify: `server/invoker.js:147-155`
- Modify: `web/src/lib/types.ts` (the `Report` interface)
- Modify: `web/src/components/result-panel.tsx` (the Report tab)
- Test: `tests/harness-node.test.js`, `tests/invoker.test.js`, `web/src/components/result-panel.test.tsx`

**Interfaces:**
- Produces: every harness's success envelope may include a numeric `initMs` field; `invoker.js`'s `invoke()` return value's `report` object may include `initMs` (rounded to 2 decimals, same as `durationMs`). Later tasks (2-4) rely on this same `report.initMs` field name and rounding.

- [ ] **Step 1: Write the failing harness test**

Add to `tests/harness-node.test.js` (it currently tests the node runtime only via `invoker.test.js`'s `'node runtime works through the invoker'` case — add a dedicated assertion there):

```js
test('node runtime reports initMs separately from durationMs', () => {
  return invoke(base('javascript/hello', { runtime: 'node', handler: 'index.handler' })).then((r) => {
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
    assert.ok(r.report.durationMs >= 0);
  });
});
```

This test doesn't exist yet in `tests/harness-node.test.js` — that file doesn't exist as a dedicated file today (Node coverage lives in `tests/invoker.test.js`); create `tests/harness-node.test.js` with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { invoke } = require('../server/invoker');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function base(fixture, extra = {}) {
  return {
    name: 'test-fn',
    dir: path.join(FIXTURES, fixture),
    runtime: 'node',
    handler: 'index.handler',
    event: {},
    ...extra,
  };
}

test('node runtime reports initMs separately from durationMs', async () => {
  const r = await invoke(base('javascript/hello'));
  assert.strictEqual(r.ok, true);
  assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
  assert.ok(r.report.durationMs >= 0);
});

test('node handler exception does not report initMs', async () => {
  const r = await invoke(base('javascript/hello', { handler: 'does-not-exist.handler' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.report.initMs, undefined);
});
```

Check `fixtures/javascript/hello` exists with an `index.handler` export (it's already used by `tests/invoker.test.js`'s `'node runtime works through the invoker'` test) before relying on it here.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harness-node.test.js`
Expected: FAIL — `r.report.initMs` is `undefined`, so `r.report.initMs >= 0` is `false`.

- [ ] **Step 3: Add the init timer to the Node harness**

In `harnesses/node/harness.mjs`, add a timer at the very top (right after the imports, before any `arg()` calls):

```js
const harnessStart = process.hrtime.bigint();
```

Then, right before the existing `const start = process.hrtime.bigint();` line (the one that starts timing the handler call), compute the elapsed init time:

```js
const start = process.hrtime.bigint();
const initMs = Number(start - harnessStart) / 1e6;
```

And add `initMs` to the **success** `writeResult` call only:

```js
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  writeResult({ ok: true, phase: 'invoke', response: response ?? null, durationMs, initMs });
```

The failure-path `writeResult` calls (both the `catch` block after handler resolution and the earlier module-resolution `catch`) are unchanged — no `initMs` field on those envelopes.

- [ ] **Step 4: Wire `initMs` through `invoker.js`**

In `server/invoker.js`, right after the existing `out.report = {...}` block (currently lines 149-155):

```js
  out.report = {
    requestId,
    durationMs: Math.round(durationMs * 100) / 100,
    billedMs: Math.max(1, Math.ceil(durationMs)),
    memoryMb,
    timedOut: run.timedOut,
  };
  if (envelope?.initMs != null) {
    out.report.initMs = Math.round(envelope.initMs * 100) / 100;
  }
  return out;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/harness-node.test.js`
Expected: PASS

- [ ] **Step 6: Add the `initMs` field to the `Report` type and the Report tab UI**

In `web/src/lib/types.ts`, extend `Report`:

```ts
export interface Report {
  requestId: string
  durationMs: number
  billedMs: number
  memoryMb: number
  timedOut: boolean
  buildMs?: number
  initMs?: number
}
```

In `web/src/components/result-panel.tsx`, in the `report` tab's template string, add an `Init Duration:` line after `Memory Size:` and before the `buildMs` line:

```tsx
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
              (result.report.initMs != null ? `Init Duration: ${result.report.initMs} ms\n` : '') +
              (result.report.buildMs != null ? `Build Duration: ${result.report.buildMs} ms\n` : '') +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
```

- [ ] **Step 7: Add a web test for the Init Duration line**

In `web/src/components/result-panel.test.tsx`, add:

```tsx
it('shows Init Duration in the Report tab when the report includes initMs', async () => {
  const withInit: InvokeResult = {
    ...ok,
    report: { ...ok.report, initMs: 42.5 },
  }
  render(<ResultPanel result={withInit} />)
  await userEvent.click(screen.getByText('Report'))
  expect(screen.getByText(/Init Duration: 42.5 ms/)).toBeInTheDocument()
})
```

- [ ] **Step 8: Run the web test suite**

Run: `npm --prefix web run test -- result-panel`
Expected: PASS

- [ ] **Step 9: Run the full server test suite to confirm no regressions**

Run: `npm run test:server`
Expected: PASS (all existing tests unaffected — `initMs` is additive)

- [ ] **Step 10: Commit**

```bash
git add harnesses/node/harness.mjs server/invoker.js web/src/lib/types.ts \
  web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx tests/harness-node.test.js
git commit -m "feat(server): report init duration separately from handler duration (Node)"
```

---

## Task 2: Python harness `initMs`

**Files:**
- Modify: `harnesses/python/harness.py`
- Test: `tests/harness-python.test.js`

**Interfaces:**
- Consumes: `server/invoker.js`'s generic `envelope?.initMs` passthrough from Task 1 (no further invoker changes needed here — it already reads `initMs` off any harness's envelope, regardless of language).

- [ ] **Step 1: Write the failing test**

Add to `tests/harness-python.test.js`, alongside the existing `'python happy path...'` test:

```js
test('python runtime reports initMs separately from durationMs', { skip: noPy }, async () => {
  const r = await invoke(base('python/hello'));
  assert.strictEqual(r.ok, true);
  assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harness-python.test.js`
Expected: FAIL — `initMs` is `undefined`.

- [ ] **Step 3: Add the init timer to the Python harness**

In `harnesses/python/harness.py`'s `main()`, add the timer as the very first line:

```python
def main():
    harness_start = time.monotonic()
    p = argparse.ArgumentParser()
```

Then, right before the existing `start = time.monotonic()` line, compute the elapsed init time:

```python
    ctx = Context(args.timeout_ms, args.memory_mb, args.request_id)
    init_ms = (time.monotonic() - harness_start) * 1000
    start = time.monotonic()
```

Add `initMs` to the success `write_result` call only:

```python
    try:
        response = func(event, ctx)
        duration = (time.monotonic() - start) * 1000
        json.dumps(response)  # raises TypeError if not JSON-serializable
        write_result(args.result_file, {
            "ok": True, "phase": "invoke",
            "response": response, "durationMs": duration, "initMs": init_ms})
```

The two failure-path `write_result` calls (module-import `except` and handler-exception `except`) are unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/harness-python.test.js`
Expected: PASS (skipped if `python3` isn't available, matching every other Python test in this file)

- [ ] **Step 5: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add harnesses/python/harness.py tests/harness-python.test.js
git commit -m "feat(server): report init duration separately from handler duration (Python)"
```

---

## Task 3: Java harness `initMs`

**Files:**
- Modify: `harnesses/java/Harness.java`
- Rebuild: `harnesses/java/harness.jar` (committed binary, built by `harnesses/java/build.sh`)
- Test: `tests/java.test.js`

**Interfaces:**
- Consumes: same generic `report.initMs` passthrough from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `tests/java.test.js`:

```js
test('java runtime reports initMs separately from durationMs', { skip }, async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/java.test.js`
Expected: FAIL if Java + the built fixture jar are available; SKIPPED otherwise (this is fine — the next steps still apply the source change, and CI/whoever has Java installed will catch a regression).

- [ ] **Step 3: Add the init timer to the Java harness**

In `harnesses/java/Harness.java`'s `main`, add the timer as the first line:

```java
    public static void main(String[] argv) throws Exception {
        long harnessStart = System.nanoTime();
        Map<String, String> args = parseArgs(argv);
```

Change the `envelope()` helper to accept an optional `initMs`:

```java
    static Map<String, Object> envelope(boolean ok, String phase, Object response,
                                        Map<String, Object> error, double durationMs, Double initMs) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("ok", ok);
        env.put("phase", phase);
        if (response != null) env.put("response", response);
        if (error != null) env.put("error", error);
        env.put("durationMs", durationMs);
        if (initMs != null) env.put("initMs", initMs);
        return env;
    }
```

Update the two call sites inside `main`'s try/catch around the method invocation: compute `initMs` right before the existing `long start = System.nanoTime();` line —

```java
        long deadline = System.currentTimeMillis() + timeoutMs;
        Class<?>[] pts = method.getParameterTypes();
        long start = System.nanoTime();
        double initMs = (start - harnessStart) / 1e6;
        try {
            Object responseTree;
            ...
            double durationMs = (System.nanoTime() - start) / 1e6;
            writeResult(resultFile, envelope(true, "invoke", responseTree, null, durationMs, initMs));
        } catch (Throwable t) {
            double durationMs = (System.nanoTime() - start) / 1e6;
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException
                && t.getCause() != null ? t.getCause() : t;
            writeResult(resultFile, envelope(false, "invoke", null, error(cause), durationMs, null));
        }
```

The earlier `catch (Throwable t)` block around handler/method resolution (the `phase: "init"` envelope) also calls `envelope(...)` — update that call site to pass `null` for `initMs` too:

```java
        } catch (Throwable t) {
            writeResult(resultFile, envelope(false, "init", null, error(t), 0, null));
            return;
        }
```

- [ ] **Step 4: Rebuild `harness.jar`**

Run: `bash harnesses/java/build.sh`
Expected: `Built harnesses/java/harness.jar` — requires JDK 11+ and network on first run (to fetch `gson.jar`, which is cached in `harnesses/java/` after that). If Java isn't installed in this environment, note that in the task result and leave `harness.jar` unchanged — a reviewer with Java available must rebuild it before this task can be considered done, since the committed jar is what every Java invoke actually runs.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/java.test.js`
Expected: PASS (or SKIPPED, per Step 2's caveat)

- [ ] **Step 6: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add harnesses/java/Harness.java harnesses/java/harness.jar tests/java.test.js
git commit -m "feat(server): report init duration separately from handler duration (Java)"
```

---

## Task 4: `provided` (OS-only) harness `initMs`

**Files:**
- Modify: `harnesses/provided/harness.mjs`
- Test: `tests/harness-provided.test.js`

**Interfaces:**
- Consumes: same generic `report.initMs` passthrough from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `tests/harness-provided.test.js` (check its existing `base()`-style helper and adapt to match; if it invokes via `invoke()` from `server/invoker.js` the same way `tests/invoker.test.js` does, add):

```js
test('provided runtime reports initMs separately from durationMs', async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.ok(r.report.initMs >= 0, `expected initMs >= 0, got ${r.report.initMs}`);
});
```

(Read `tests/harness-provided.test.js` first to match its existing fixture/helper names exactly — don't guess at a fixture path that doesn't match what's already there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harness-provided.test.js`
Expected: FAIL — `initMs` is `undefined`.

- [ ] **Step 3: Add the init timer to the `provided` harness**

In `harnesses/provided/harness.mjs`, add a timer at the top (right after the imports, alongside the existing `const resultFile = arg(...)` block):

```js
const harnessStart = process.hrtime.bigint();
```

Add a module-level `let initMs = null;` next to the existing `let startedAt = null;` / `let polled = false;` declarations.

In the `GET /invocation/next` handler, where `startedAt` is first set, also compute `initMs`:

```js
  if (req.method === 'GET' && url === `${BASE}/invocation/next`) {
    if (startedAt === null) {
      startedAt = process.hrtime.bigint();
      initMs = Number(startedAt - harnessStart) / 1e6;
    }
    polled = true;
```

Add `initMs` to the **success** response handler only (`/invocation/{requestId}/response`):

```js
  if (req.method === 'POST' && url === `${BASE}/invocation/${requestId}/response`) {
    const body = await readBody(req);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"status":"OK"}');
    let response;
    try { response = JSON.parse(body); } catch { response = body; }
    return finish({ ok: true, phase: 'invoke', response, durationMs: durationMs(), initMs });
  }
```

The error/init-error/exit-code failure paths are unchanged — no `initMs` on those.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/harness-provided.test.js`
Expected: PASS

- [ ] **Step 5: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add harnesses/provided/harness.mjs tests/harness-provided.test.js
git commit -m "feat(server): report init duration separately from handler duration (provided runtime)"
```

---

## Task 5: `server/history.js` — persist `trace`, add `getByRequestId`/`appendSpans`

**Files:**
- Modify: `server/history.js`
- Test: `tests/history.test.js`

**Interfaces:**
- Produces: `history.append(functionId, entry)` accepts an optional `entry.trace` (`{ spans: Span[], pending: boolean } | null`), capped/truncated like `report`. `history.getByRequestId(functionId, requestId) -> storedEntry | null`. `history.appendSpans(functionId, requestId, spans, pending) -> void` — merges `spans` into the matching entry's `trace.spans` and sets `trace.pending`; no-ops if `functionId` is falsy or no matching entry exists.
- Consumes (in later tasks): Task 7 (`trace-collector.js`) calls `appendSpans`; Task 10 (read API) calls `getByRequestId`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/history.test.js`:

```js
test('append persists trace and includes it in truncated flag', () => {
  const stored = history.append('fn12', entry({ trace: { spans: [{ name: 'a' }], pending: true } }));
  assert.deepStrictEqual(stored.trace, { spans: [{ name: 'a' }], pending: true });
  const listed = history.list('fn12')[0];
  assert.deepStrictEqual(listed.trace, { spans: [{ name: 'a' }], pending: true });
});

test('getByRequestId finds an entry by its report.requestId', () => {
  history.append('fn13', entry({ report: { requestId: 'req-find-me', durationMs: 1 } }));
  const found = history.getByRequestId('fn13', 'req-find-me');
  assert.ok(found);
  assert.strictEqual(found.report.requestId, 'req-find-me');
  assert.strictEqual(history.getByRequestId('fn13', 'no-such-id'), null);
  assert.strictEqual(history.getByRequestId('no-such-fn', 'req-find-me'), null);
});

test('appendSpans merges spans into the matching entry and updates pending', () => {
  history.append('fn14', entry({
    report: { requestId: 'req-merge', durationMs: 1 },
    trace: { spans: [{ name: 'first' }], pending: true },
  }));
  history.appendSpans('fn14', 'req-merge', [{ name: 'second' }], true);
  let found = history.getByRequestId('fn14', 'req-merge');
  assert.deepStrictEqual(found.trace.spans, [{ name: 'first' }, { name: 'second' }]);
  assert.strictEqual(found.trace.pending, true);

  history.appendSpans('fn14', 'req-merge', [], false);
  found = history.getByRequestId('fn14', 'req-merge');
  assert.strictEqual(found.trace.pending, false);
  assert.strictEqual(found.trace.spans.length, 2);
});

test('appendSpans no-ops for an unknown functionId, requestId, or falsy functionId', () => {
  assert.doesNotThrow(() => history.appendSpans(undefined, 'req-x', [{ name: 'x' }], true));
  assert.doesNotThrow(() => history.appendSpans('no-such-fn', 'req-x', [{ name: 'x' }], true));
  history.append('fn15', entry({ report: { requestId: 'req-y', durationMs: 1 } }));
  assert.doesNotThrow(() => history.appendSpans('fn15', 'no-such-request', [{ name: 'x' }], true));
  assert.strictEqual(history.getByRequestId('fn15', 'req-y').trace, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/history.test.js`
Expected: FAIL — `history.getByRequestId` and `history.appendSpans` are not functions yet; `stored.trace` is `undefined`.

- [ ] **Step 3: Implement `trace` persistence in `append`**

In `server/history.js`'s `append` function:

```js
function append(functionId, entry) {
  const logs = capString(entry.logs ?? '');
  const event = capJson(entry.event);
  const response = capJson(entry.response);
  const report = capJson(entry.report ?? null);
  const trace = capJson(entry.trace ?? null);
  const stored = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    handler: entry.handler ?? '',
    source: entry.source ?? { type: 'manual' },
    event: event.value,
    eventTruncated: event.truncated,
    response: response.value,
    responseTruncated: response.truncated,
    error: entry.error ?? null,
    logs: logs.value,
    report: report.value,
    trace: trace.value,
    durationMs: entry.durationMs ?? null,
    ok: !!entry.ok,
    truncated: logs.truncated || event.truncated || response.truncated || report.truncated || trace.truncated,
  };
  const file = fileFor(functionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(stored) + '\n');
  try {
    if (fs.statSync(file).size > compactBytes()) {
      writeAll(functionId, readAll(functionId).slice(-MAX_ENTRIES));
    }
  } catch {}
  return stored;
}
```

- [ ] **Step 4: Implement `getByRequestId` and `appendSpans`**

Add below `append`:

```js
function getByRequestId(functionId, requestId) {
  return readAll(functionId).find((e) => e.report?.requestId === requestId) ?? null;
}

// Merges late-arriving spans into an already-persisted entry, found by its
// report.requestId (entries aren't otherwise indexed by that field). No-ops
// if the entry isn't found -- e.g. it was trimmed by MAX_ENTRIES compaction
// while the trace window was still open, an edge the window's short default
// (10s) makes unlikely to matter in practice.
function appendSpans(functionId, requestId, spans, pending) {
  if (!functionId) return;
  const all = readAll(functionId);
  const entry = all.find((e) => e.report?.requestId === requestId);
  if (!entry) return;
  const existingSpans = Array.isArray(entry.trace?.spans) ? entry.trace.spans : [];
  const merged = capJson({ spans: existingSpans.concat(spans), pending });
  entry.trace = merged.value;
  entry.truncated = entry.truncated || merged.truncated;
  writeAll(functionId, all);
}
```

- [ ] **Step 5: Export the new functions**

```js
module.exports = { append, list, clear, getByRequestId, appendSpans, MAX_ENTRIES, MAX_FIELD_BYTES,
  COMPACT_BYTES, compactBytes };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/history.test.js`
Expected: PASS

- [ ] **Step 7: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/history.js tests/history.test.js
git commit -m "feat(server): persist invoke traces in history, add span merge/lookup by requestId"
```

---

## Task 6: `server/otlp-decode.js` — hand-rolled OTLP protobuf/JSON decoder

**Files:**
- Create: `server/otlp-decode.js`
- Test: `tests/otlp-decode.test.js`

**Interfaces:**
- Produces: `decodeProtobuf(buffer) -> ResourceSpansGroup[]`, `decodeJson(text) -> ResourceSpansGroup[]`, where `ResourceSpansGroup = { resourceAttributes: Record<string, string|number|boolean>, spans: Span[] }` and `Span = { traceId: string (hex), spanId: string (hex), parentSpanId: string|null (hex), name: string, startTimeUnixNano: string, endTimeUnixNano: string, attributes: Record<string, string|number|boolean> }`. Both throw on structurally malformed input (unsupported protobuf wire type, or `JSON.parse` failure).
- Consumes (in Task 8): `server/trace-receiver.js` calls both functions based on the incoming request's `content-type`.

This decoder's field numbers were verified directly against the published [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) `.proto` sources while writing the design spec — see the spec's "New dependencies" section for why no library covers this (the official `@opentelemetry/otlp-transformer` package only implements the exporter side: `serializeRequest`/`deserializeResponse`, not decoding an incoming request).

- [ ] **Step 1: Write the failing tests**

Create `tests/otlp-decode.test.js` with a small test-only protobuf encoder (mirrors the same field numbers the production decoder reads) plus tests for both codecs:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { decodeProtobuf, decodeJson } = require('../server/otlp-decode');

// --- minimal protobuf encoder, test-only, mirrors the field numbers the
// production decoder in server/otlp-decode.js reads ---
function writeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    bytes.push(b);
  } while (v !== 0n);
  return Buffer.from(bytes);
}
function tag(fieldNumber, wireType) { return writeVarint((fieldNumber << 3) | wireType); }
function lengthDelimited(fieldNumber, payload) {
  return Buffer.concat([tag(fieldNumber, 2), writeVarint(payload.length), payload]);
}
function stringField(fieldNumber, str) { return lengthDelimited(fieldNumber, Buffer.from(str, 'utf8')); }
function fixed64Field(fieldNumber, n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return Buffer.concat([tag(fieldNumber, 1), buf]);
}
function bytesField(fieldNumber, hex) { return lengthDelimited(fieldNumber, Buffer.from(hex, 'hex')); }

// KeyValue { key: string(1), value: AnyValue(2) }, AnyValue.string_value = field 1
function encodeKeyValue(key, stringValue) {
  return Buffer.concat([stringField(1, key), lengthDelimited(2, stringField(1, stringValue))]);
}
// Span message bytes (no outer tag/len)
function encodeSpan({ traceId, spanId, parentSpanId, name, startNs, endNs, attrs }) {
  const parts = [bytesField(1, traceId), bytesField(2, spanId)];
  if (parentSpanId) parts.push(bytesField(4, parentSpanId));
  parts.push(stringField(5, name), fixed64Field(7, startNs), fixed64Field(8, endNs));
  for (const [k, v] of Object.entries(attrs ?? {})) parts.push(lengthDelimited(9, encodeKeyValue(k, v)));
  return Buffer.concat(parts);
}
// ScopeSpans message bytes: repeated Span at field 2
function encodeScopeSpansMessage(spans) {
  return Buffer.concat(spans.map((s) => lengthDelimited(2, encodeSpan(s))));
}
// Resource message bytes: repeated KeyValue at field 1
function encodeResourceMessage(attrs) {
  return Buffer.concat(Object.entries(attrs).map(([k, v]) => lengthDelimited(1, encodeKeyValue(k, v))));
}
// ResourceSpans message bytes: resource at field1, one ScopeSpans entry at field2
function encodeResourceSpansMessage({ resourceAttrs, spans }) {
  const resourceEntry = lengthDelimited(1, encodeResourceMessage(resourceAttrs));
  const scopeSpansEntry = lengthDelimited(2, encodeScopeSpansMessage(spans));
  return Buffer.concat([resourceEntry, scopeSpansEntry]);
}
// ExportTraceServiceRequest message bytes: resource_spans at field1
function encodeRequest({ resourceAttrs, spans }) {
  return lengthDelimited(1, encodeResourceSpansMessage({ resourceAttrs, spans }));
}

test('decodeProtobuf reads a resource attribute and a span back out', () => {
  const buf = encodeRequest({
    resourceAttrs: { 'faas.invocation_id': 'req-123' },
    spans: [{
      traceId: 'aabbccddeeff00112233445566778899',
      spanId: '0011223344556677',
      parentSpanId: null,
      name: 'do-thing',
      startNs: 1_000_000_000,
      endNs: 1_050_000_000,
      attrs: { 'http.method': 'GET' },
    }],
  });
  const [group] = decodeProtobuf(buf);
  assert.deepStrictEqual(group.resourceAttributes, { 'faas.invocation_id': 'req-123' });
  assert.strictEqual(group.spans.length, 1);
  const [span] = group.spans;
  assert.strictEqual(span.traceId, 'aabbccddeeff00112233445566778899');
  assert.strictEqual(span.spanId, '0011223344556677');
  assert.strictEqual(span.parentSpanId, null);
  assert.strictEqual(span.name, 'do-thing');
  assert.strictEqual(span.startTimeUnixNano, '1000000000');
  assert.strictEqual(span.endTimeUnixNano, '1050000000');
  assert.deepStrictEqual(span.attributes, { 'http.method': 'GET' });
});

test('decodeProtobuf reads a parent span id when present', () => {
  const buf = encodeRequest({
    resourceAttrs: {},
    spans: [{
      traceId: 'aa', spanId: 'bb', parentSpanId: 'cc', name: 'child',
      startNs: 1, endNs: 2, attrs: {},
    }],
  });
  assert.strictEqual(decodeProtobuf(buf)[0].spans[0].parentSpanId, 'cc');
});

test('decodeProtobuf throws on an unsupported wire type', () => {
  // field 1, wire type 3 ("start group") -- deprecated/unsupported in proto3
  assert.throws(() => decodeProtobuf(Buffer.from([0x0b])));
});

test('decodeJson reads the equivalent proto3 JSON mapping', () => {
  const json = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: 'faas.invocation_id', value: { stringValue: 'req-456' } }] },
      scopeSpans: [{
        spans: [{
          traceId: Buffer.from('aabbcc', 'hex').toString('base64'),
          spanId: Buffer.from('001122', 'hex').toString('base64'),
          name: 'json-span',
          startTimeUnixNano: '2000000000',
          endTimeUnixNano: '2010000000',
          attributes: [{ key: 'ok', value: { boolValue: true } }],
        }],
      }],
    }],
  });
  const [group] = decodeJson(json);
  assert.deepStrictEqual(group.resourceAttributes, { 'faas.invocation_id': 'req-456' });
  assert.strictEqual(group.spans[0].traceId, 'aabbcc');
  assert.strictEqual(group.spans[0].name, 'json-span');
  assert.strictEqual(group.spans[0].startTimeUnixNano, '2000000000');
  assert.deepStrictEqual(group.spans[0].attributes, { ok: true });
});

test('decodeJson throws on invalid JSON', () => {
  assert.throws(() => decodeJson('not json'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/otlp-decode.test.js`
Expected: FAIL — `Cannot find module '../server/otlp-decode'`

- [ ] **Step 3: Implement `server/otlp-decode.js`**

```js
// Minimal, read-only decoder for exactly the OTLP messages this playground
// needs: ExportTraceServiceRequest -> ResourceSpans -> ScopeSpans -> Span,
// plus the common KeyValue/AnyValue/Resource types. The official
// @opentelemetry/otlp-transformer package only implements the exporter side
// (encode a request, decode a response) -- there's no supported decode-a-
// request entry point to reuse, so this hand-rolls just enough of the wire
// format to read the fixed, versioned schema at
// https://github.com/open-telemetry/opentelemetry-proto.

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let b;
  do {
    b = buf[pos.i];
    pos.i += 1;
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return result;
}

// Splits one embedded message's bytes into field-number -> raw-value-list.
// Doesn't know what any field means yet -- the decode* functions below
// interpret specific field numbers; everything else is simply never read.
function splitFields(buf) {
  const fields = new Map();
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    let value;
    if (wireType === 0) {
      value = readVarint(buf, pos);
    } else if (wireType === 1) {
      value = buf.subarray(pos.i, pos.i + 8);
      pos.i += 8;
    } else if (wireType === 2) {
      const len = Number(readVarint(buf, pos));
      value = buf.subarray(pos.i, pos.i + len);
      pos.i += len;
    } else if (wireType === 5) {
      value = buf.subarray(pos.i, pos.i + 4);
      pos.i += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType} (field ${fieldNumber})`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

function toHex(buf) {
  return Buffer.from(buf ?? []).toString('hex');
}

function readFixed64LE(buf) {
  return buf ? buf.readBigUInt64LE(0).toString() : '0';
}

function decodeAnyValue(buf) {
  const f = splitFields(buf);
  if (f.has(1)) return Buffer.from(f.get(1)[0]).toString('utf8'); // string_value
  if (f.has(2)) return f.get(2)[0] !== 0n; // bool_value
  if (f.has(3)) return Number(BigInt.asIntN(64, f.get(3)[0])); // int_value
  if (f.has(4)) return Buffer.from(f.get(4)[0]).readDoubleLE(0); // double_value
  return undefined; // array/kvlist/bytes values: not needed for our attributes
}

function decodeKeyValue(buf) {
  const f = splitFields(buf);
  const key = f.get(1)?.[0] ? Buffer.from(f.get(1)[0]).toString('utf8') : undefined;
  const valueBuf = f.get(2)?.[0];
  return { key, value: valueBuf ? decodeAnyValue(valueBuf) : undefined };
}

function decodeAttributeList(fields, fieldNumber) {
  const out = {};
  for (const raw of fields.get(fieldNumber) ?? []) {
    const { key, value } = decodeKeyValue(raw);
    if (key !== undefined) out[key] = value;
  }
  return out;
}

function decodeSpan(buf) {
  const f = splitFields(buf);
  return {
    traceId: toHex(f.get(1)?.[0]),
    spanId: toHex(f.get(2)?.[0]),
    parentSpanId: f.get(4)?.[0] ? toHex(f.get(4)[0]) : null,
    name: f.get(5)?.[0] ? Buffer.from(f.get(5)[0]).toString('utf8') : '',
    startTimeUnixNano: readFixed64LE(f.get(7)?.[0]),
    endTimeUnixNano: readFixed64LE(f.get(8)?.[0]),
    attributes: decodeAttributeList(f, 9),
  };
}

function decodeScopeSpans(buf) {
  const f = splitFields(buf);
  return (f.get(2) ?? []).map(decodeSpan);
}

function decodeResourceSpans(buf) {
  const f = splitFields(buf);
  const resourceAttributes = f.get(1)?.[0] ? decodeAttributeList(splitFields(f.get(1)[0]), 1) : {};
  const spans = (f.get(2) ?? []).flatMap(decodeScopeSpans);
  return { resourceAttributes, spans };
}

// Returns one { resourceAttributes, spans } group per ResourceSpans entry.
function decodeProtobuf(buf) {
  const f = splitFields(buf);
  return (f.get(1) ?? []).map(decodeResourceSpans);
}

// Same output shape as decodeProtobuf, from the proto3 JSON mapping instead
// of the wire format: bytes fields are base64, 64-bit ints are decimal
// strings (already what we want for start/endTimeUnixNano).
function jsonAnyValue(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  return undefined;
}

function jsonAttributeList(attrs) {
  const out = {};
  for (const kv of attrs ?? []) {
    if (kv?.key === undefined) continue;
    out[kv.key] = jsonAnyValue(kv.value);
  }
  return out;
}

function base64ToHex(b64) {
  return b64 ? Buffer.from(b64, 'base64').toString('hex') : '';
}

function decodeJson(text) {
  const parsed = JSON.parse(text);
  return (parsed.resourceSpans ?? []).map((rs) => ({
    resourceAttributes: jsonAttributeList(rs.resource?.attributes),
    spans: (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => ({
      traceId: base64ToHex(s.traceId),
      spanId: base64ToHex(s.spanId),
      parentSpanId: s.parentSpanId ? base64ToHex(s.parentSpanId) : null,
      name: s.name ?? '',
      startTimeUnixNano: s.startTimeUnixNano ?? '0',
      endTimeUnixNano: s.endTimeUnixNano ?? '0',
      attributes: jsonAttributeList(s.attributes),
    }))),
  }));
}

module.exports = { decodeProtobuf, decodeJson };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/otlp-decode.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/otlp-decode.js tests/otlp-decode.test.js
git commit -m "feat(server): hand-rolled OTLP protobuf/JSON trace decoder"
```

---

## Task 7: `server/trace-collector.js` — correlation window + buffering

**Files:**
- Create: `server/trace-collector.js`
- Test: `tests/trace-collector.test.js`

**Interfaces:**
- Consumes: `server/history.js`'s `appendSpans(functionId, requestId, spans, pending)` from Task 5.
- Produces: `open(requestId, functionId)`, `ingest(requestId, spans)`, `snapshotAndStartWindow(requestId) -> { spans: Span[] }`, `close(requestId)`, `windowMs() -> number`. Later tasks: Task 8 (`trace-receiver.js`) calls `ingest`; Task 9 (`invoker.js`) calls `open` and `snapshotAndStartWindow`.

- [ ] **Step 1: Write the failing tests**

Create `tests/trace-collector.test.js`:

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-tc-'));
const history = require('../server/history');
const traceCollector = require('../server/trace-collector');

beforeEach(() => {
  process.env.AWS_PLAYGROUND_TRACE_WINDOW_MS = '50';
});

test('spans ingested before the window starts are included in the snapshot', () => {
  traceCollector.open('req-1', 'fn-a');
  traceCollector.ingest('req-1', [{ name: 'span-a' }]);
  const { spans } = traceCollector.snapshotAndStartWindow('req-1');
  assert.deepStrictEqual(spans, [{ name: 'span-a' }]);
});

test('ingest for an unknown requestId is dropped silently', () => {
  assert.doesNotThrow(() => traceCollector.ingest('never-opened', [{ name: 'x' }]));
});

test('spans ingested during the post-exit window are persisted to history', async () => {
  history.append('fn-b', { report: { requestId: 'req-2', durationMs: 1 }, ok: true, logs: '' });
  traceCollector.open('req-2', 'fn-b');
  traceCollector.snapshotAndStartWindow('req-2');
  traceCollector.ingest('req-2', [{ name: 'late-span' }]);
  const found = history.getByRequestId('fn-b', 'req-2');
  assert.deepStrictEqual(found.trace.spans, [{ name: 'late-span' }]);
  assert.strictEqual(found.trace.pending, true);
});

test('the window closes after windowMs, drops the buffer, and marks history not pending', async () => {
  history.append('fn-c', { report: { requestId: 'req-3', durationMs: 1 }, ok: true, logs: '' });
  traceCollector.open('req-3', 'fn-c');
  traceCollector.snapshotAndStartWindow('req-3');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const found = history.getByRequestId('fn-c', 'req-3');
  assert.strictEqual(found.trace.pending, false);
  // a straggler after close is dropped, not reopening the window
  traceCollector.ingest('req-3', [{ name: 'too-late' }]);
  assert.strictEqual(history.getByRequestId('fn-c', 'req-3').trace.spans.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/trace-collector.test.js`
Expected: FAIL — `Cannot find module '../server/trace-collector'`

- [ ] **Step 3: Implement `server/trace-collector.js`**

```js
const history = require('./history');

function windowMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_TRACE_WINDOW_MS, 10);
  return Number.isFinite(parsed) ? parsed : 10_000;
}

// requestId -> { functionId, spans, closesAt }
const buffers = new Map();
const timers = new Map();

function open(requestId, functionId) {
  buffers.set(requestId, { functionId, spans: [], closesAt: null });
}

// Called whenever a span batch for this requestId arrives. If the invoke
// has already exited (closesAt set, i.e. invoke() already returned its
// initial snapshot), the newly-arrived spans are also persisted right
// away, since the web UI relies on polling to pick these up.
function ingest(requestId, spans) {
  const buf = buffers.get(requestId);
  if (!buf) return; // unknown or already-closed requestId: drop silently
  buf.spans.push(...spans);
  if (buf.closesAt !== null && buf.functionId) {
    try { history.appendSpans(buf.functionId, requestId, spans, true); } catch {}
  }
}

// Called right after the invoked child process exits. Returns the current
// snapshot for the invoke's initial response, and starts the countdown
// after which no more spans are accepted for this requestId.
function snapshotAndStartWindow(requestId) {
  const buf = buffers.get(requestId);
  if (!buf) return { spans: [] };
  const spans = buf.spans.slice();
  buf.closesAt = Date.now() + windowMs();
  const timer = setTimeout(() => close(requestId), windowMs());
  timer.unref?.();
  timers.set(requestId, timer);
  return { spans };
}

function close(requestId) {
  const buf = buffers.get(requestId);
  buffers.delete(requestId);
  const timer = timers.get(requestId);
  if (timer) { clearTimeout(timer); timers.delete(requestId); }
  if (buf?.functionId) {
    try { history.appendSpans(buf.functionId, requestId, [], false); } catch {}
  }
}

module.exports = { open, ingest, snapshotAndStartWindow, close, windowMs };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/trace-collector.test.js`
Expected: PASS

- [ ] **Step 5: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/trace-collector.js tests/trace-collector.test.js
git commit -m "feat(server): buffer and correlate incoming OTLP spans by invoke, with a bounded post-exit window"
```

---

## Task 8: `server/trace-receiver.js` — loopback OTLP/HTTP listener

**Files:**
- Create: `server/trace-receiver.js`
- Test: `tests/trace-receiver.test.js`

**Interfaces:**
- Consumes: `server/otlp-decode.js`'s `decodeProtobuf`/`decodeJson` (Task 6), `server/trace-collector.js`'s `ingest` (Task 7).
- Produces: `endpoint() -> Promise<string>` (resolves to `http://127.0.0.1:<port>/v1/traces`), `close() -> Promise<void>`. Consumed by Task 9 (`invoker.js`).

This test uses the **real** OTel exporter packages (`@opentelemetry/sdk-trace`, `@opentelemetry/resources`, `@opentelemetry/exporter-trace-otlp-proto`) as devDependencies, posting genuine OTLP requests at the receiver rather than hand-built bytes — this is the same combination verified by hand while writing the design spec (real span → real protobuf bytes → this receiver → our decoder → correct output).

- [ ] **Step 1: Add OTel packages as devDependencies for this test**

Run: `npm install --save-dev @opentelemetry/api@^1.9.0 @opentelemetry/resources@^2.10.0 @opentelemetry/sdk-trace@^2.10.0 @opentelemetry/exporter-trace-otlp-proto@^0.221.0`

(from the repo root — these are root `devDependencies`, used only by this test, not shipped in `package.json`'s `"files"` list and not installed into any user project.)

- [ ] **Step 2: Write the failing tests**

Create `tests/trace-receiver.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/trace-receiver.test.js`
Expected: FAIL — `Cannot find module '../server/trace-receiver'`

- [ ] **Step 4: Implement `server/trace-receiver.js`**

```js
// A tiny, always-on, loopback-only HTTP server that accepts OTLP/HTTP span
// exports from invoked handlers. Kept separate from the main web server's
// port because that port isn't reliably known here: production picks one
// at startup (bin/cli.js), but dev mode runs entirely inside `vite dev`
// (no bin/cli.js involved), and trigger-invoked calls have no incoming
// HTTP request to read a host from. Same listen(0, ...)-then-read-back-the-
// port pattern harnesses/provided/harness.mjs already uses for its Runtime
// API emulation.
const http = require('http');
const { decodeProtobuf, decodeJson } = require('./otlp-decode');
const traceCollector = require('./trace-collector');

const FAAS_INVOCATION_ID = 'faas.invocation_id';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/traces') {
    res.writeHead(404);
    return res.end();
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let groups;
  try {
    const contentType = req.headers['content-type'] || '';
    groups = contentType.includes('json') ? decodeJson(body.toString('utf8')) : decodeProtobuf(body);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`could not decode OTLP request: ${err.message}`);
  }
  for (const { resourceAttributes, spans } of groups) {
    const requestId = resourceAttributes[FAAS_INVOCATION_ID];
    if (typeof requestId === 'string') traceCollector.ingest(requestId, spans);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
// Doesn't keep the process (or a test file's `node --test` run) alive on
// its own -- it's fine for this listener to still technically be "open"
// when everything else the process was doing has finished.
server.unref();

const readyPromise = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function endpoint() {
  const port = await readyPromise;
  return `http://127.0.0.1:${port}/v1/traces`;
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = { endpoint, close };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/trace-receiver.test.js`
Expected: PASS

- [ ] **Step 6: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/trace-receiver.js tests/trace-receiver.test.js package.json package-lock.json
git commit -m "feat(server): loopback OTLP/HTTP receiver for invoke span capture"
```

---

## Task 9: Wire tracing into `server/invoker.js` and `server/api/invoke.js`

**Files:**
- Modify: `server/invoker.js`
- Modify: `server/api/invoke.js`
- Test: `tests/invoker.test.js`

**Interfaces:**
- Consumes: `server/trace-receiver.js`'s `endpoint()` (Task 8), `server/trace-collector.js`'s `open`/`snapshotAndStartWindow` (Task 7).
- Produces: `invoke(opts)` accepts an optional `opts.id` (the function's id, used only to attribute persisted spans to the right history file); its return value gains `trace: { spans: Span[], pending: boolean }`, always present. `server/api/invoke.js` passes `id: fn.id` and includes `result.trace` in the history entry.

- [ ] **Step 1: Write the failing test**

Add to `tests/invoker.test.js`:

```js
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
```

(`fixtures/javascript/env-echo` already exists and is used by the existing `'env: AWS defaults set...'` and `'proxy and TLS trust vars...'` tests in this file — it echoes back requested env var names from `event.keys`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/invoker.test.js`
Expected: FAIL — `r.trace` is `undefined`; the OTEL env vars aren't set.

- [ ] **Step 3: Wire tracing into `invoker.js`**

Add requires near the top of `server/invoker.js`:

```js
const traceReceiver = require('./trace-receiver');
const traceCollector = require('./trace-collector');
```

Change `buildEnv`'s signature and body to accept and set the OTLP vars:

```js
function buildEnv(opts, memoryMb, requestId, otlpEndpoint) {
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.AWS_LAMBDA_FUNCTION_NAME = opts.name || 'playground';
  env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = String(memoryMb);
  env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  env.AWS_REGION = 'us-east-1';
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = otlpEndpoint;
  env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';
  env.OTEL_RESOURCE_ATTRIBUTES = `faas.invocation_id=${requestId}`;
  Object.assign(env, opts.env || {});
  return env;
}
```

In `invoke()`, open the trace buffer right after `requestId` is generated, resolve the receiver's endpoint before building `env`, and attach `out.trace` right before the final `return out;`:

```js
async function invoke(opts) {
  const requestId = crypto.randomUUID();
  traceCollector.open(requestId, opts.id);
  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryMb = opts.memoryMb ?? 128;
  const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
  const harnessArgs = ['--handler', opts.handler, '--result-file', resultFile,
    '--timeout-ms', String(timeoutMs), '--memory-mb', String(memoryMb),
    '--request-id', requestId];
  const { cmd, args } = command(opts, harnessArgs);
  const otlpEndpoint = await traceReceiver.endpoint();
  const env = buildEnv(opts, memoryMb, requestId, otlpEndpoint);
```

(the rest of the function body — spawning, timeout handling, envelope parsing — is unchanged)

Right before the existing final `return out;`:

```js
  if (envelope?.initMs != null) {
    out.report.initMs = Math.round(envelope.initMs * 100) / 100;
  }
  const { spans } = traceCollector.snapshotAndStartWindow(requestId);
  out.trace = { spans, pending: true };
  return out;
}
```

- [ ] **Step 4: Pass the function id through from `server/api/invoke.js`**

In `server/api/invoke.js`, add `id: fn.id,` to the `invoke({...})` call:

```js
      result = await invoke({
        id: fn.id,
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
```

And include `trace` in the `history.append` call:

```js
      history.append(fn.id, {
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
        response: result.response,
        error: result.error ?? null,
        logs: result.logs,
        report: result.report,
        trace: result.trace ?? null,
        durationMs: result.report.durationMs,
        ok: result.ok,
        source: source ?? { type: 'manual' },
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/invoker.test.js`
Expected: PASS

- [ ] **Step 6: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/invoker.js server/api/invoke.js tests/invoker.test.js
git commit -m "feat(server): inject OTLP env vars per invoke and attach captured spans to the result"
```

---

## Task 10: Read API for a single invoke's trace + web types

**Files:**
- Modify: `server/api/history.js`
- Modify: `server/api/index.js`
- Create: `web/src/routes/api.functions.$id.history.$requestId.trace.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/types.ts`
- Test: `tests/api.test.js`

**Interfaces:**
- Produces: `backend.getInvokeTrace(functionId, requestId) -> { status, body }`; `api.getTrace(functionId, requestId) -> Promise<{ trace: Trace | null }>`; `Span`/`Trace` types in `web/src/lib/types.ts`; `InvokeResult`/`HistoryEntry` gain `trace?: Trace | null`. Consumed by Task 11 (`useTracePoll`) and Task 12 (`TracePanel`).

- [ ] **Step 1: Write the failing backend test**

Add to `tests/api.test.js` (after the existing function CRUD test, reusing its `hello` function fixture pattern):

```js
test('getInvokeTrace returns 404 for an unknown function, null trace when none recorded, and the persisted trace otherwise', () => {
  let r = api.createFunction({ name: 'trace-fn', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const id = r.body.id;

  r = api.getInvokeTrace('no-such-fn', 'req-1');
  assert.strictEqual(r.status, 404);

  r = api.getInvokeTrace(id, 'no-such-request');
  assert.strictEqual(r.status, 404);

  api.invokeFunction({ functionId: id, event: {} });
  const history = api.listHistory(id).body.entries;
  const requestId = history[0].report.requestId;
  r = api.getInvokeTrace(id, requestId);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.trace, { spans: [], pending: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL — `api.getInvokeTrace is not a function`

- [ ] **Step 3: Implement `getInvokeTrace` in `server/api/history.js`**

```js
function getInvokeTrace(functionId, requestId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  const entry = history.getByRequestId(functionId, requestId);
  if (!entry) return { status: 404, body: { error: 'invoke not found' } };
  return { status: 200, body: { trace: entry.trace ?? null } };
}

module.exports = { listHistory, clearHistory, getInvokeTrace };
```

- [ ] **Step 4: Wire it into `server/api/index.js`**

```js
const { health } = require('./health');
const { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect } = require('./functions');
const { invokeFunction } = require('./invoke');
const { listServices, startService, stopService, setSelection } = require('./services');
const { listHistory, clearHistory, getInvokeTrace } = require('./history');
const { listTriggerStatus } = require('./triggers');

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory, getInvokeTrace,
  listServices, startService, stopService, setSelection, listTriggerStatus, RUNTIMES };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/api.test.js`
Expected: PASS

- [ ] **Step 6: Add the web route, `Trace`/`Span` types, and the `api.getTrace` call**

Create `web/src/routes/api.functions.$id.history.$requestId.trace.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id/history/$requestId/trace')({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(backend.getInvokeTrace(params.id, params.requestId)),
    },
  },
})
```

In `web/src/lib/types.ts`, add near `LambdaError`:

```ts
export interface Span {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, string | number | boolean>
}

export interface Trace {
  spans: Span[]
  pending: boolean
}
```

Extend `InvokeResult` and `HistoryEntry`:

```ts
export interface InvokeResult {
  ok: boolean
  phase: 'init' | 'invoke' | 'build' | 'service'
  response?: unknown
  error?: LambdaError
  logs: string
  report: Report
  trace?: Trace
}
```

```ts
export interface HistoryEntry {
  id: string
  ts: number
  handler: string
  source: InvokeSource
  event: unknown
  eventTruncated: boolean
  response?: unknown
  responseTruncated: boolean
  error?: LambdaError | null
  logs: string
  report: Report | null
  trace?: Trace | null
  durationMs: number | null
  ok: boolean
  truncated: boolean
}
```

In `web/src/lib/api.ts`, import `Trace` alongside the existing type imports and add:

```ts
  getTrace: (id: string, requestId: string) =>
    request<{ trace: Trace | null }>(`/api/functions/${id}/history/${requestId}/trace`),
```

- [ ] **Step 7: Run the web typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS

- [ ] **Step 8: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/api/history.js server/api/index.js \
  web/src/routes/api.functions.\$id.history.\$requestId.trace.ts \
  web/src/lib/api.ts web/src/lib/types.ts tests/api.test.js
git commit -m "feat(web): read API for a single invoke's captured trace"
```

---

## Task 11: `useTracePoll` hook + wire live updates into `index.tsx`

**Files:**
- Modify: `web/src/lib/queries.ts`
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/lib/queries.test.tsx`

**Interfaces:**
- Consumes: `api.getTrace` from Task 10.
- Produces: `useTracePoll(functionId, requestId, pending) -> UseQueryResult<{ trace: Trace | null }>`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/lib/queries.test.tsx`, extending the existing `vi.mock('@/lib/api', ...)` block with a `getTrace` mock:

```tsx
vi.mock('@/lib/api', () => ({
  api: {
    listServices: vi.fn().mockResolvedValue({ docker: { available: true }, services: [] }),
    listTriggerStatus: vi.fn().mockResolvedValue({}),
    listHistory: vi.fn().mockResolvedValue({ entries: [] }),
    getTrace: vi.fn().mockResolvedValue({ trace: { spans: [], pending: true } }),
  },
}))
```

(keep the existing imports; add `useTracePoll` to the `from '@/lib/queries'` import list)

```tsx
it('polls for a trace only while pending is true, and stops once told pending is false', async () => {
  vi.useFakeTimers()
  const { rerender } = renderHook(
    ({ pending }: { pending: boolean }) => useTracePoll('fn-1', 'req-1', pending),
    { wrapper: makeWrapper(), initialProps: { pending: true } },
  )

  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(api.getTrace).toHaveBeenCalledTimes(1)

  await act(() => vi.advanceTimersByTimeAsync(1_500))
  expect(api.getTrace).toHaveBeenCalledTimes(2)

  rerender({ pending: false })
  const callsAtStop = vi.mocked(api.getTrace).mock.calls.length
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(api.getTrace).toHaveBeenCalledTimes(callsAtStop)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- queries`
Expected: FAIL — `useTracePoll` is not exported

- [ ] **Step 3: Implement `useTracePoll`**

In `web/src/lib/queries.ts`, add near `useHistoryQuery`:

```ts
export function useTracePoll(functionId: string | null, requestId: string | null, pending: boolean) {
  return useQuery({
    queryKey: ['trace', functionId, requestId],
    queryFn: () => api.getTrace(functionId!, requestId!),
    enabled: pending && !!functionId && !!requestId,
    refetchInterval: pending ? 1_500 : false,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- queries`
Expected: PASS

- [ ] **Step 5: Wire it into `web/src/routes/index.tsx`**

Add `useTracePoll` to the existing `from '@/lib/queries'` import. Right after the existing `const invoke = useInvoke()` line, add:

```tsx
  const currentRequestId = result?.report.requestId ?? null
  const tracePending = result?.trace?.pending === true
  const tracePoll = useTracePoll(selectedId, currentRequestId, tracePending)
  useEffect(() => {
    if (!tracePoll.data?.trace) return
    setResult((r) => (r && r.report.requestId === currentRequestId ? { ...r, trace: tracePoll.data!.trace! } : r))
  }, [tracePoll.data, currentRequestId])
```

- [ ] **Step 6: Run the web test suite and typecheck**

Run: `npm --prefix web run test && npm --prefix web run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/queries.ts web/src/lib/queries.test.tsx web/src/routes/index.tsx
git commit -m "feat(web): poll for late-arriving spans while the current invoke's trace is pending"
```

---

## Task 12: `TracePanel` component + wire into `ResultPanel`

**Files:**
- Create: `web/src/components/trace-panel.tsx`
- Modify: `web/src/components/result-panel.tsx`
- Test: `web/src/components/trace-panel.test.tsx`, additions to `web/src/components/result-panel.test.tsx`

**Interfaces:**
- Consumes: `Span`/`Trace` types from Task 10.
- Produces: `TracePanel({ spans: Span[] })` component.

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/trace-panel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TracePanel } from '@/components/trace-panel'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'root-span',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

it('shows an empty state with no spans', () => {
  render(<TracePanel spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders a span with its name, duration, and attributes', () => {
  render(<TracePanel spans={[span({ name: 'do-work', attributes: { 'http.method': 'GET' } })]} />)
  expect(screen.getByText('do-work')).toBeInTheDocument()
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
  expect(screen.getByText(/http\.method="GET"/)).toBeInTheDocument()
})

it('indents a child span under its parent', () => {
  const parent = span({ spanId: 'parent-1', name: 'parent-span' })
  const child = span({ spanId: 'child-1', parentSpanId: 'parent-1', name: 'child-span' })
  render(<TracePanel spans={[parent, child]} />)
  const childRow = screen.getByText('child-span').closest('li')
  const parentRow = screen.getByText('parent-span').closest('li')
  const childPad = Number((childRow?.style.paddingLeft ?? '0').replace('px', ''))
  const parentPad = Number((parentRow?.style.paddingLeft ?? '0').replace('px', ''))
  expect(childPad).toBeGreaterThan(parentPad)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- trace-panel`
Expected: FAIL — `Cannot find module '@/components/trace-panel'`

- [ ] **Step 3: Implement `TracePanel`**

Create `web/src/components/trace-panel.tsx`:

```tsx
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Span } from '@/lib/types'

function spanDurationMs(span: Span): number {
  const start = BigInt(span.startTimeUnixNano)
  const end = BigInt(span.endTimeUnixNano)
  return Number(end - start) / 1e6
}

// Walks parentSpanId links up to the root, capped by `seen` in case of a
// cycle (malformed input shouldn't infinite-loop the UI).
function depthOf(span: Span, byId: Map<string, Span>): number {
  let depth = 0
  let current = span
  const seen = new Set<string>()
  while (current.parentSpanId && byId.has(current.parentSpanId) && !seen.has(current.spanId)) {
    seen.add(current.spanId)
    current = byId.get(current.parentSpanId)!
    depth += 1
  }
  return depth
}

export function TracePanel({ spans }: { spans: Span[] }) {
  if (spans.length === 0) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        No spans received — export to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT from your handler to see spans here.
      </div>
    )
  }
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const sorted = [...spans].sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y font-mono text-xs">
        {sorted.map((span) => (
          <li
            key={span.spanId}
            className="flex items-baseline gap-2 px-3 py-1.5"
            style={{ paddingLeft: `${12 + depthOf(span, byId) * 16}px` }}
          >
            <span className="font-medium">{span.name}</span>
            <span className="text-muted-foreground">{spanDurationMs(span).toFixed(2)}ms</span>
            {Object.keys(span.attributes).length > 0 && (
              <span className="truncate text-muted-foreground/70">
                {Object.entries(span.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- trace-panel`
Expected: PASS

- [ ] **Step 5: Wire the Trace tab into `ResultPanel`**

`invoke()` (Task 9) always sets a `trace` field — `{ spans: [], pending: false }` for a plain invoke with no OTel SDK involved, same shape as a populated one. So there's no meaningful "has a trace vs. doesn't" distinction to gate the tab on, unlike `checks` (which genuinely doesn't exist until a script runs). The Trace tab is therefore always present, exactly like Response/Logs/Report — `TracePanel` itself renders the "invoke to see..." / "no spans received" empty states depending on whether `result` exists yet.

In `web/src/components/result-panel.tsx`, import `TracePanel`:

```tsx
import { TracePanel } from '@/components/trace-panel'
```

Add a `TabsTrigger` after `report` and before the conditional `checks` trigger (unconditional, like `report` itself):

```tsx
          <TabsTrigger value="report" className={TAB}>Report</TabsTrigger>
          <TabsTrigger value="trace" className={TAB}>Trace</TabsTrigger>
          {checkResults != null && <TabsTrigger value="checks" className={TAB}>Checks</TabsTrigger>}
```

No change needed to the controlled `value` fallback logic — `trace` is never removed out from under an active tab the way `checks` can be, so there's nothing to fall back from.

Add the `TabsContent`, after the `report` content and before the conditional `checks` content:

```tsx
      <TabsContent value="trace" className="min-h-0 flex-1">
        <TracePanel key={result?.report.requestId ?? 'empty'} spans={result?.trace?.spans ?? []} />
      </TabsContent>
```

- [ ] **Step 6: Add result-panel tests for the Trace tab**

Add to `web/src/components/result-panel.test.tsx`:

```tsx
it('shows the Trace tab\'s empty state when the result has no spans', async () => {
  const withEmptyTrace: InvokeResult = { ...ok, trace: { spans: [], pending: false } }
  render(<ResultPanel result={withEmptyTrace} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('shows the Trace tab before any invoke has happened', async () => {
  render(<ResultPanel result={null} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders captured spans in the Trace tab', async () => {
  const withSpans: InvokeResult = {
    ...ok,
    trace: {
      pending: false,
      spans: [{
        traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
        startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000', attributes: {},
      }],
    },
  }
  render(<ResultPanel result={withSpans} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText('do-work')).toBeInTheDocument()
})
```

- [ ] **Step 7: Run the full web test suite and typecheck**

Run: `npm --prefix web run test && npm --prefix web run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/src/components/trace-panel.tsx web/src/components/trace-panel.test.tsx \
  web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx
git commit -m "feat(web): add a Trace tab rendering captured spans"
```

---

## Task 13: End-to-end fixture — real OTel SDK span through the real receiver

**Files:**
- Create: `fixtures/typescript/otel-span/package.json`
- Create: `fixtures/typescript/otel-span/tsconfig.json`
- Create: `fixtures/typescript/otel-span/src/index.ts`
- Create (committed build output): `fixtures/typescript/otel-span/dist/index.js`
- Test: `tests/harness-node-otel.test.js`

**Interfaces:**
- Consumes: `server/trace-receiver.js`, `server/trace-collector.js` (Tasks 7-8), the real `harnesses/node/harness.mjs` (Task 1).

This fixture's shape — merged env-detected `Resource`, `SimpleSpanProcessor`, explicit `forceFlush()` before returning — was verified by hand while writing the design spec: without the merge, `faas.invocation_id` never reaches the span; without the `forceFlush()`, the span is silently lost regardless of processor type, because ending a span only starts an asynchronous HTTP export and `process.exit(0)` (right after the harness writes its result file) kills the process before that I/O completes.

- [ ] **Step 1: Create the fixture's `package.json`**

`fixtures/typescript/otel-span/package.json`:

```json
{
  "name": "ts-otel-span-fixture",
  "private": true,
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --target=node18 --outfile=dist/index.js"
  },
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/resources": "^2.10.0",
    "@opentelemetry/sdk-trace": "^2.10.0",
    "@opentelemetry/exporter-trace-otlp-proto": "^0.221.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create the fixture's `tsconfig.json`**

Copy the shape of `fixtures/typescript/node-s3/tsconfig.json` verbatim (read it first) into `fixtures/typescript/otel-span/tsconfig.json` — every existing TypeScript fixture shares the same compiler options; there's no reason for this one to differ.

- [ ] **Step 3: Write the fixture handler**

`fixtures/typescript/otel-span/src/index.ts`:

```ts
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
```

- [ ] **Step 4: Install and build the fixture**

Run: `cd fixtures/typescript/otel-span && npm install && npm run build`
Expected: `dist/index.js` is created. If `esbuild` reports an unresolved import for some transitive OTel package, add `--external:<package-name>` to the `build` script in `package.json` for that specific package (none were observed when this exact dependency set was test-built while writing this plan, but pin down and document any that appear here rather than papering over the error).

- [ ] **Step 5: Write the failing end-to-end test**

Create `tests/harness-node-otel.test.js`, mirroring `tests/harness-node-s3.test.js`'s structure:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-otel-'));
const traceReceiver = require('../server/trace-receiver');
const traceCollector = require('../server/trace-collector');

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

test('a real OTel-instrumented handler\'s span round-trips through the real /v1/traces receiver',
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
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].name, 'do-work');
  assert.strictEqual(spans[0].attributes['event.name'], 'world');
});
```

- [ ] **Step 6: Run the test**

Run: `node --test tests/harness-node-otel.test.js`
Expected: PASS (or SKIPPED if `dist/index.js` wasn't built in this environment)

- [ ] **Step 7: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add fixtures/typescript/otel-span tests/harness-node-otel.test.js
git commit -m "test: add an OTel-instrumented fixture proving the trace capture path end to end"
```

---

## Task 14: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a short section documenting the Trace tab**

Add a new section after wherever the README currently documents the Report/Logs tabs (read the README first to match its existing heading level and tone), covering:

- What the Trace tab shows and when it appears (only once a `trace` is present on the result).
- The two env vars every invoke gets: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` (`http/protobuf`), plus `OTEL_RESOURCE_ATTRIBUTES=faas.invocation_id=<requestId>` used for correlation.
- The two gotchas verified while building this feature: (1) call `forceFlush()`/`shutdown()` on the tracer provider before the handler returns — ending a span only starts an asynchronous export, and the process exits immediately after responding; (2) a hand-built `Resource` doesn't pick up `OTEL_RESOURCE_ATTRIBUTES` unless merged with `detectResources({ detectors: [envDetector] })` — `@opentelemetry/sdk-node`'s `NodeSDK` does this automatically, a hand-rolled `TracerProvider` setup does not.
- Point at `fixtures/typescript/otel-span` as a working example.
- One line on the Init Duration line now shown in the Report tab.

- [ ] **Step 2: Proofread against the actual behavior**

Re-read the new section next to `docs/superpowers/specs/2026-08-27-invoke-tracing-design.md`'s "Error handling & edge cases" section and confirm nothing drifted from what was actually implemented in Tasks 1-13.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the Trace tab, OTLP env vars, and the flush/resource gotchas"
```

---

## Task 15: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: PASS (both `test:server` and `test:web`)

- [ ] **Step 2: Run the web typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: succeeds, `web/dist/server/server.js` exists afterward.

- [ ] **Step 4: Manually smoke-test in a browser**

Start the playground (`npm start`), register the `fixtures/typescript/otel-span` fixture (runtime `node`, handler `dist/index.handler`, build command left empty since `dist/` is committed), invoke it with `{"name": "playground"}`, and confirm:
- The Report tab shows an `Init Duration:` line.
- The Trace tab shows one `do-work` span with an `event.name="playground"` attribute.
- Re-registering a function with no OTel SDK (e.g. `fixtures/python/hello`) and invoking it shows the Trace tab's empty state ("No spans received...") rather than hiding the tab — this is the intended behavior (Task 12, Step 5): since every invoke gets a `trace` field regardless of OTel usage, the tab is always present, the same way Response/Logs/Report always are, rather than only appearing once a handler happens to be instrumented.

- [ ] **Step 5: Report results**

Summarize: test suite status, build status, and the outcome of the manual smoke test.
