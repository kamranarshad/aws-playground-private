# Node Auto-Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Node.js function opt into real OpenTelemetry spans for common libraries (HTTP, AWS SDK, DB drivers) with zero OTel code in the handler, via a `--require` bootstrap the playground injects at launch — never touching the user's project, and never applied if the handler already sets up its own tracing.

**Architecture:** A static, pre-flight check (`server/auto-trace-detect.js`) decides once per invoke, before anything spawns, whether the project already declares its own `@opentelemetry/sdk-trace*` dependency. If not, `server/invoker.js` adds a `--require` flag pointing at a new CommonJS bootstrap (`harnesses/node/auto-trace-bootstrap.cjs`) that sets up a default `TracerProvider` plus `@opentelemetry/auto-instrumentations-node`, reading the exact same `OTEL_*` env vars every invoke already gets. The Node harness gets one small addition — flush the bootstrap's spans before exiting, mirroring the `forceFlush()` requirement every manual OTel example already has.

**Tech Stack:** Node.js, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/instrumentation`, `@opentelemetry/context-async-hooks` — all newly-required **runtime** dependencies of the playground itself (not the user's project). React + TanStack Query for the toggle UI.

**Spec:** `docs/superpowers/specs/2026-08-30-node-auto-tracing-design.md`

## Global Constraints

- Node only — Python, Java, and `provided` are out of scope (see spec's Scope decisions).
- Opt-in per function via a new `autoTrace: boolean` field on `FunctionDef`, default `false`.
- A handler with its own OTel SDK dependency (`@opentelemetry/sdk-trace*` in `dependencies` or `devDependencies`) is detected statically before spawning and auto-tracing is skipped entirely for that invoke — never layered on top, never raced at runtime.
- The bootstrap file **must be `.cjs`**, not `.mjs` — OTel's Node auto-instrumentation patches libraries via CommonJS `require()` hooking, which native ES module `import` never goes through. This is verified, load-bearing, and not a style choice.
- Only handlers Node loads as CommonJS (hand-written `.cjs`/`.js` without `"type": "module"`, or any file a build step compiles to CJS output, e.g. esbuild's default) actually get auto-traced. A native ESM handler runs correctly but produces zero auto-instrumented spans — a documented, accepted gap, not an error.
- Auto-tracing reuses the exact existing span-capture pipeline (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, the receiver, the collector, the Trace tab) — nothing about span capture, correlation, or display changes in this plan.
- No comments explaining *what* code does — only *why*, matching this codebase's existing style throughout.

---

## Task 1: `server/auto-trace-detect.js` — static tracing-setup detection

**Files:**
- Create: `server/auto-trace-detect.js`
- Test: `tests/auto-trace-detect.test.js`

**Interfaces:**
- Produces: `hasOwnTracingSetup(projectDir) -> boolean`. Later tasks (4) call this before deciding whether to inject the auto-trace bootstrap.

- [ ] **Step 1: Write the failing tests**

Create `tests/auto-trace-detect.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasOwnTracingSetup } = require('../server/auto-trace-detect');

function projectWith(pkgJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-autotrace-'));
  if (pkgJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson));
  }
  return dir;
}

test('true when @opentelemetry/sdk-trace-node is a direct dependency', () => {
  const dir = projectWith({ dependencies: { '@opentelemetry/sdk-trace-node': '^2.0.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('true when the sdk-trace package is only a devDependency', () => {
  const dir = projectWith({ devDependencies: { '@opentelemetry/sdk-trace': '^2.0.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});

test('false when only @opentelemetry/api is present -- the API alone configures nothing', () => {
  const dir = projectWith({ dependencies: { '@opentelemetry/api': '^1.9.0' } });
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json has no dependencies at all', () => {
  const dir = projectWith({ name: 'x' });
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json is missing', () => {
  const dir = projectWith(undefined);
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('false when package.json is malformed JSON', () => {
  const dir = projectWith(undefined);
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  assert.strictEqual(hasOwnTracingSetup(dir), false);
});

test('real fixture: otel-span declares its own tracing and is correctly detected', () => {
  const dir = path.join(__dirname, '..', 'fixtures', 'typescript', 'otel-span');
  assert.strictEqual(hasOwnTracingSetup(dir), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/auto-trace-detect.test.js`
Expected: FAIL — `Cannot find module '../server/auto-trace-detect'`

- [ ] **Step 3: Implement `server/auto-trace-detect.js`**

```js
const fs = require('fs');
const path = require('path');

// True when the project already sets up its own tracer provider -- checked
// against dependencies AND devDependencies, since either one means "this
// project has its own OTel SDK wiring," not just the API package (which
// alone configures nothing).
function hasOwnTracingSetup(projectDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.keys(deps).some((name) => name.startsWith('@opentelemetry/sdk-trace'));
}

module.exports = { hasOwnTracingSetup };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/auto-trace-detect.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/auto-trace-detect.js tests/auto-trace-detect.test.js
git commit -m "feat(server): detect whether a project already sets up its own OTel tracing"
```

---

## Task 2: Playground dependencies + the auto-trace bootstrap

**Files:**
- Modify: `package.json` (root)
- Create: `harnesses/node/auto-trace-bootstrap.cjs`
- Test: `tests/auto-trace-bootstrap.test.js`

**Interfaces:**
- Produces: a file at `harnesses/node/auto-trace-bootstrap.cjs` that, when loaded via Node's `--require` flag, sets `globalThis.__awsPlaygroundFlushTracing` to an async function. Task 3 (harness flush hook) and Task 4 (invoker wiring) depend on this exact global name and file path.

- [ ] **Step 1: Move existing OTel packages from devDependencies to dependencies, and add the new ones**

The root `package.json` currently has `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace`, and `@opentelemetry/exporter-trace-otlp-proto` under `devDependencies` — they were added there for tests only. The bootstrap needs these at **runtime** for every real invoke, so a package installed via `npm install` without dev dependencies (the normal case for an end user of the published tool) would silently break auto-tracing if they stayed as dev-only. Move those four to `dependencies`, and add three new ones (`@opentelemetry/context-async-hooks`, `@opentelemetry/instrumentation`, `@opentelemetry/auto-instrumentations-node`). Leave `@opentelemetry/exporter-trace-otlp-http` in `devDependencies` — it's genuinely test-only (used by `tests/trace-receiver.test.js` to prove the JSON decode path, not by any production code path).

Edit `package.json`'s `dependencies`/`devDependencies` blocks to read exactly:

```json
  "devDependencies": {
    "@opentelemetry/exporter-trace-otlp-http": "^0.221.0",
    "oxlint": "^1.79.0"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.1118.0",
    "@aws-sdk/client-dynamodb-streams": "^3.1118.0",
    "@aws-sdk/client-s3": "^3.1119.0",
    "@aws-sdk/client-sqs": "^3.1117.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/auto-instrumentations-node": "^0.79.0",
    "@opentelemetry/context-async-hooks": "^2.10.0",
    "@opentelemetry/exporter-trace-otlp-proto": "^0.221.0",
    "@opentelemetry/instrumentation": "^0.221.0",
    "@opentelemetry/resources": "^2.10.0",
    "@opentelemetry/sdk-trace": "^2.10.0"
  },
```

(Read the current `package.json` first to confirm you're editing the actual current version strings/keys rather than assuming — the `@aws-sdk/*` entries and any other unrelated dependency additions since this plan was written must be preserved, not overwritten.)

Run: `npm install`
Expected: succeeds, `node_modules/@opentelemetry/auto-instrumentations-node` and `node_modules/@opentelemetry/instrumentation` now exist.

- [ ] **Step 2: Write the failing test**

Create `tests/auto-trace-bootstrap.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BOOTSTRAP = path.join(__dirname, '..', 'harnesses', 'node', 'auto-trace-bootstrap.cjs');

test('loading the bootstrap does not throw and defines the flush hook', () => {
  const output = execFileSync(process.execPath,
    ['--require', BOOTSTRAP, '-e', 'console.log(typeof globalThis.__awsPlaygroundFlushTracing)'],
    { encoding: 'utf8' });
  assert.strictEqual(output.trim(), 'function');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/auto-trace-bootstrap.test.js`
Expected: FAIL — `Cannot find module '.../auto-trace-bootstrap.cjs'`

- [ ] **Step 4: Implement the bootstrap**

Create `harnesses/node/auto-trace-bootstrap.cjs`:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/auto-trace-bootstrap.test.js`
Expected: PASS

- [ ] **Step 6: Run the previously-existing OTel tests to confirm the dependency move didn't break anything**

Run: `node --test tests/otlp-decode.test.js tests/trace-receiver.test.js tests/trace-collector.test.js tests/harness-node-otel.test.js`
Expected: PASS (these all depend on packages that just moved from dev to regular dependencies — must still resolve correctly)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json harnesses/node/auto-trace-bootstrap.cjs tests/auto-trace-bootstrap.test.js
git commit -m "feat(server): add the Node auto-tracing bootstrap and its dependencies"
```

---

## Task 3: Harness flush hook

**Files:**
- Modify: `harnesses/node/harness.mjs`
- Test: `tests/harness-node.test.js`

**Interfaces:**
- Consumes: `globalThis.__awsPlaygroundFlushTracing` (from Task 2's bootstrap, when loaded).
- Produces: the harness awaits and calls that hook (if defined) before writing its result file, on both the success and failure paths.

- [ ] **Step 1: Write the failing test**

Add to `tests/harness-node.test.js` (read the file first — it already has a `base()` helper and `require('../server/invoker')`; this test spawns the harness directly instead, to control the `--require` flag precisely, so it needs its own small helpers rather than reusing `invoke()`):

```js
const { execFile } = require('node:child_process');
const os = require('node:os');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'node', 'harness.mjs');

function makeNodeFixture(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-flush-fixture-'));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
  return dir;
}

function runHarnessDirect(dir, extraEnv) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hflush-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', 'index.handler', '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-flush'],
      { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv } },
      () => {
        let envelope = null;
        try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); fs.unlinkSync(resultFile); } catch {}
        resolve(envelope);
      });
    child.stdin.end('{}');
  });
}

test('harness awaits and calls globalThis.__awsPlaygroundFlushTracing before exiting, on success and on failure', async () => {
  const flushMarker = path.join(os.tmpdir(), `flush-marker-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const stubRequire = path.join(os.tmpdir(), `flush-stub-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(stubRequire, `
    globalThis.__awsPlaygroundFlushTracing = async () => {
      require('fs').appendFileSync(${JSON.stringify(flushMarker)}, 'flushed\\n');
    };
  `);
  const okDir = makeNodeFixture(`exports.handler = async () => ({ ok: true });`);
  const errDir = makeNodeFixture(`exports.handler = async () => { throw new Error('boom'); };`);
  try {
    const okEnvelope = await runHarnessDirect(okDir, { NODE_OPTIONS: `--require ${stubRequire}` });
    assert.strictEqual(okEnvelope.ok, true);
    const errEnvelope = await runHarnessDirect(errDir, { NODE_OPTIONS: `--require ${stubRequire}` });
    assert.strictEqual(errEnvelope.ok, false);

    const flushLog = fs.readFileSync(flushMarker, 'utf8');
    assert.strictEqual(flushLog.split('\n').filter(Boolean).length, 2);
  } finally {
    fs.rmSync(flushMarker, { force: true });
    fs.rmSync(stubRequire, { force: true });
    fs.rmSync(okDir, { recursive: true, force: true });
    fs.rmSync(errDir, { recursive: true, force: true });
  }
});

test('harness does not fail when no auto-tracing hook is defined (the common case)', async () => {
  const okDir = makeNodeFixture(`exports.handler = async () => ({ ok: true });`);
  try {
    const envelope = await runHarnessDirect(okDir, {});
    assert.strictEqual(envelope.ok, true);
  } finally {
    fs.rmSync(okDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/harness-node.test.js`
Expected: the new "awaits and calls" test FAILs (flush log has 0 lines, not 2) — the "does not fail when no hook defined" test passes already, since `?.()` on `undefined` is already safe even before this change (confirm this is genuinely a pre-existing pass, not a false green from a bug in the test itself, by reading the harness's current code: it doesn't call the hook at all yet, so nothing to safely skip — this test is here to guard the *next* step's addition, not to fail now).

- [ ] **Step 3: Add the flush hook to the harness**

In `harnesses/node/harness.mjs`, the success and failure branches currently end with:

```js
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  writeResult({ ok: true, phase: 'invoke', response: response ?? null, durationMs, initMs });
} catch (err) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  writeResult({ ok: false, phase: 'invoke', durationMs, error: shape(err) });
}
```

Change to:

```js
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  await globalThis.__awsPlaygroundFlushTracing?.();
  writeResult({ ok: true, phase: 'invoke', response: response ?? null, durationMs, initMs });
} catch (err) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  await globalThis.__awsPlaygroundFlushTracing?.();
  writeResult({ ok: false, phase: 'invoke', durationMs, error: shape(err) });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/harness-node.test.js`
Expected: PASS

- [ ] **Step 5: Run the broader targeted suite to confirm no regression**

Run: `node --test tests/invoker.test.js tests/harness-node-otel.test.js tests/harness-python.test.js tests/harness-provided.test.js tests/java.test.js`
Expected: PASS (this touches the shared Node harness, so the other language harnesses and the manual-tracing e2e test are the relevant regression surface)

- [ ] **Step 6: Commit**

```bash
git add harnesses/node/harness.mjs tests/harness-node.test.js
git commit -m "feat(server): flush auto-traced spans before the Node harness exits"
```

---

## Task 4: Wire detection + `--require` into `server/invoker.js`

**Files:**
- Modify: `server/invoker.js`
- Modify: `server/api/invoke.js`
- Test: `tests/invoker.test.js`

**Interfaces:**
- Consumes: `hasOwnTracingSetup(projectDir)` (Task 1), the bootstrap file path (Task 2).
- Produces: `invoke(opts)` accepts an optional `opts.autoTrace` (boolean); when true, `opts.runtime === 'node'`, and `hasOwnTracingSetup(opts.dir)` is false, the spawned Node command includes `--require <bootstrap path>` before the harness script path.

- [ ] **Step 1: Write the failing test**

Add to `tests/invoker.test.js` (this fixture already exists and is used by `tests/harness-node-otel.test.js`, so its own `dist/index.js` must already be built — the test below is `{ skip: ... }`-gated the same way):

```js
const { hasOwnTracingSetup } = require('../server/auto-trace-detect');

test('autoTrace does not interfere with a handler that already sets up its own tracing (otel-span)',
  { skip: fs.existsSync(path.join(FIXTURES, 'typescript/otel-span/dist/index.js')) ? false : 'fixture dist not built' },
  async () => {
  const otelSpanDir = path.join(FIXTURES, 'typescript/otel-span');
  assert.strictEqual(hasOwnTracingSetup(otelSpanDir), true, 'precondition: otel-span must declare its own tracing');

  const r = await invoke(base('typescript/otel-span', {
    runtime: 'node', handler: 'dist/index.handler', autoTrace: true, id: 'fn-autotrace-skip-test',
  }));
  assert.strictEqual(r.ok, true);
  // otel-span's own manual pipeline produces exactly 5 spans (see its own
  // fixture source) -- if auto-tracing had incorrectly layered on top
  // instead of being skipped, this would differ (e.g. the handler's own
  // setGlobalTracerProvider silently rejected because the bootstrap won
  // the registration race -- exactly the failure mode detection exists to
  // prevent).
  assert.strictEqual(r.trace.spans.length, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invoker.test.js`
Expected: FAIL or SKIP depending on whether `fixtures/typescript/otel-span/dist/index.js` exists in this environment (it does, from earlier work in this repo) — if it runs, it currently passes trivially since `autoTrace` isn't read yet and has no effect either way. This is expected: the test won't meaningfully distinguish "wired correctly" from "not wired at all" until Step 3 changes behavior for the *positive* case, proven properly in Task 8's fixture-based test. This test's real job is regression coverage — confirm it runs and passes both before and after Step 3.

- [ ] **Step 3: Wire detection and `--require` into `invoker.js`**

In `server/invoker.js`, add a require near the top:

```js
const { hasOwnTracingSetup } = require('./auto-trace-detect');
```

Add a constant near `HARNESS_DIR`:

```js
const AUTO_TRACE_BOOTSTRAP = path.join(HARNESS_DIR, 'node', 'auto-trace-bootstrap.cjs');
```

Change `command(opts, harnessArgs)` to accept the extra Node flags and only apply them for the node branch:

```js
function command(opts, harnessArgs, nodeRequireArgs = []) {
  if (opts.runtime === 'python') {
    const interp = findVenvPython(opts.dir) || 'python3';
    return { cmd: interp, args: [path.join(HARNESS_DIR, 'python', 'harness.py'), ...harnessArgs] };
  }
  if (opts.runtime === 'node') {
    return { cmd: process.execPath, args: [...nodeRequireArgs, path.join(HARNESS_DIR, 'node', 'harness.mjs'), ...harnessArgs] };
  }
  if (opts.runtime === 'provided') {
    return { cmd: process.execPath, args: [path.join(HARNESS_DIR, 'provided', 'harness.mjs'), ...harnessArgs] };
  }
  if (opts.runtime === 'java') {
    const harnessJar = path.join(HARNESS_DIR, 'java', 'harness.jar');
    const cp = [harnessJar, opts.jarPath].filter(Boolean).join(path.delimiter);
    return { cmd: 'java', args: ['-cp', cp, 'Harness', ...harnessArgs] };
  }
  throw new Error(`Unknown runtime: ${opts.runtime}`);
}
```

In `invoke(opts)`, right after `const harnessArgs = [...]` and before `const { cmd, args } = command(opts, harnessArgs);`, compute the auto-trace decision and pass it through:

```js
  const nodeRequireArgs = (opts.runtime === 'node' && opts.autoTrace && !hasOwnTracingSetup(opts.dir))
    ? ['--require', AUTO_TRACE_BOOTSTRAP]
    : [];
  const { cmd, args } = command(opts, harnessArgs, nodeRequireArgs);
```

(This sits between the existing `const harnessArgs = [...]` block and the existing `const otlpEndpoint = await traceReceiver.endpoint();` line — read the current file to place it correctly relative to those two, since line numbers will have shifted since this plan was written.)

- [ ] **Step 4: Pass `autoTrace` through from `server/api/invoke.js`**

In `server/api/invoke.js`, find the `invoke({...})` call (it already passes `id: fn.id` from an earlier feature) and add `autoTrace: fn.autoTrace,` alongside it:

```js
      result = await invoke({
        id: fn.id,
        autoTrace: fn.autoTrace,
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/invoker.test.js`
Expected: PASS

- [ ] **Step 6: Run the full targeted suite**

Run: `node --test tests/invoker.test.js tests/harness-node.test.js tests/harness-node-otel.test.js tests/harness-python.test.js tests/harness-provided.test.js tests/java.test.js tests/auto-trace-detect.test.js tests/auto-trace-bootstrap.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/invoker.js server/api/invoke.js tests/invoker.test.js
git commit -m "feat(server): inject the auto-tracing bootstrap for opted-in Node invokes"
```

---

## Task 5: `autoTrace` field — store + API validation

**Files:**
- Modify: `server/store.js`
- Modify: `server/api/functions.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Produces: `FunctionDef` objects (server-side) gain `autoTrace: boolean`, defaulting to `false` on create, patchable via update, validated as a boolean.

- [ ] **Step 1: Write the failing test**

Add to `tests/api.test.js` (reuses the same `hello` fixture pattern the existing function-CRUD test uses):

```js
test('autoTrace defaults to false on create and can be toggled via update', () => {
  let r = api.createFunction({ name: 'autotrace-fn', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.autoTrace, false);
  const id = r.body.id;

  r = api.updateFunction(id, { autoTrace: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.autoTrace, true);

  r = api.updateFunction(id, { autoTrace: 'yes' });
  assert.strictEqual(r.status, 400);
  // rejected patch must not apply
  const unaffected = api.listFunctions().body.functions.find((f) => f.id === id);
  assert.strictEqual(unaffected.autoTrace, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL — `r.body.autoTrace` is `undefined`, not `false`; the `autoTrace: 'yes'` update incorrectly succeeds with status 200 instead of 400.

- [ ] **Step 3: Add `autoTrace` to the store**

In `server/store.js`, add `'autoTrace'` to `ALLOWED_KEYS`:

```js
const ALLOWED_KEYS = ['name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'envFile', 'buildCommand', 'localServices',
  'savedEvents', 'trigger', 'autoTrace'];
```

In `create(input)`, add a default alongside the other defaulted fields:

```js
    trigger: input.trigger ?? null,
    autoTrace: input.autoTrace ?? false,
```

- [ ] **Step 4: Add validation in `server/api/functions.js`**

In `fieldError(fields, currentId)`, add a check alongside the existing `memoryMb` check:

```js
  if ('autoTrace' in fields && typeof fields.autoTrace !== 'boolean') {
    return 'autoTrace must be a boolean';
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/api.test.js`
Expected: PASS

- [ ] **Step 6: Run the full targeted suite**

Run: `node --test tests/api.test.js tests/store.test.js tests/invoker.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/store.js server/api/functions.js tests/api.test.js
git commit -m "feat(server): add the autoTrace field to functions, with validation"
```

---

## Task 6: Web toggle — `FunctionDef.autoTrace`, `AutoTraceToggle`, wiring

**Files:**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/components/auto-trace-toggle.tsx`
- Modify: `web/src/components/function-header.tsx`
- Test: `web/src/components/auto-trace-toggle.test.tsx` (new), `web/src/components/function-header.test.tsx`
- Modify (ripple from the new required field — see Step 1): `web/src/components/env-editor.test.tsx`, `web/src/components/app-sidebar.test.tsx`, `web/src/components/settings-dialog.test.tsx`, `web/src/components/trigger-toggle.test.tsx`, `web/src/components/event-panel.test.tsx`, `web/src/components/trigger-button.test.tsx`, `web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `useUpdateFunction()` from `web/src/lib/queries.ts` (already exists, unchanged).
- Produces: `FunctionDef.autoTrace: boolean`; `<AutoTraceToggle fn={fn} />` component.

- [ ] **Step 1: Add `autoTrace` to `FunctionDef` and fix every existing test literal**

In `web/src/lib/types.ts`, add the field to `FunctionDef`:

```ts
export interface FunctionDef {
  id: string
  name: string
  path: string
  runtime: Runtime
  handler: string
  timeoutMs: number
  memoryMb: number
  jarPath: string | null
  env: Record<string, string>
  envFile: string
  buildCommand: string
  localServices: string[]
  trigger: FunctionTrigger | null
  savedEvents: SavedEvent[]
  autoTrace: boolean
}
```

This makes every hand-built `FunctionDef` object literal in the test suite fail to typecheck (`autoTrace` now required). Add `autoTrace: false,` to each of the following — every one already has a `savedEvents: []` (or `savedEvents: [], ...overrides,` in `event-panel.test.tsx`'s factory function) to place it next to:

- `web/src/components/env-editor.test.tsx:19`
- `web/src/components/app-sidebar.test.tsx:15`
- `web/src/components/settings-dialog.test.tsx:19`
- `web/src/components/trigger-toggle.test.tsx:18`
- `web/src/components/event-panel.test.tsx:32` (a factory function with `...overrides` — add `autoTrace: false,` to the base object, before `...overrides`, so an individual test can still override it if ever needed)
- `web/src/components/function-header.test.tsx:20`
- `web/src/components/trigger-button.test.tsx:18`
- `web/src/routes/index.test.tsx:34` and `:35` (two separate literal functions in an array) and `:59` (a third, different literal further down the same file — read the file to find it, since it isn't adjacent to the first two)

For each, the mechanical edit is: wherever `savedEvents: []` or `savedEvents: [],` appears in one of these exact lines, add `autoTrace: false,` immediately after it (or `autoTrace: false` with no trailing comma if it's the last property before a closing brace with no trailing comma already — match each file's existing comma style rather than guessing).

- [ ] **Step 2: Run typecheck to verify the ripple is exactly these files**

Run: `npm --prefix web run typecheck`
Expected: after Step 1's edits, PASS. If it still fails, the error output names the exact remaining file:line — fix those too (this list was accurate when the plan was written, but confirm against the actual current state of the repo rather than assuming it's exhaustive).

- [ ] **Step 3: Write the failing test for the new toggle**

Create `web/src/components/auto-trace-toggle.test.tsx`:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { updateFunction: vi.fn().mockResolvedValue({}) } }))

import { AutoTraceToggle } from '@/components/auto-trace-toggle'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const nodeFn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null,
  savedEvents: [], autoTrace: false,
}

it('renders nothing for a non-Node runtime', () => {
  const { container } = render(<AutoTraceToggle fn={{ ...nodeFn, runtime: 'python' }} />, { wrapper: makeWrapper() })
  expect(container).toBeEmptyDOMElement()
})

it('toggles autoTrace via PATCH', async () => {
  render(<AutoTraceToggle fn={nodeFn} />, { wrapper: makeWrapper() })
  await userEvent.click(screen.getByRole('checkbox'))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { autoTrace: true })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm --prefix web run test -- auto-trace-toggle`
Expected: FAIL — `Cannot find module '@/components/auto-trace-toggle'`

- [ ] **Step 5: Implement `AutoTraceToggle`**

Create `web/src/components/auto-trace-toggle.tsx`:

```tsx
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

// Node-only opt-in for OpenTelemetry auto-instrumentation (HTTP, AWS SDK,
// common DB drivers) with zero code changes to the handler -- hidden for
// other runtimes since the underlying mechanism (a Node --require flag)
// doesn't generalize to them. A handler with its own tracing setup wins
// regardless of this toggle (server/auto-trace-detect.js decides that per
// invoke), so turning this on is always safe to try.
export function AutoTraceToggle({ fn }: { fn: FunctionDef }) {
  const update = useUpdateFunction()
  if (fn.runtime !== 'node') return null
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
      title="Auto-instrument common libraries (HTTP, AWS SDK, DB drivers) with zero code changes -- skipped if the handler already sets up its own tracing"
    >
      <input
        type="checkbox"
        className="accent-primary"
        checked={fn.autoTrace}
        onChange={(e) => update.mutate({ id: fn.id, patch: { autoTrace: e.target.checked } })}
      />
      Auto-trace
    </label>
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm --prefix web run test -- auto-trace-toggle`
Expected: PASS

- [ ] **Step 7: Wire it into `FunctionHeader`**

In `web/src/components/function-header.tsx`, add the import:

```tsx
import { AutoTraceToggle } from '@/components/auto-trace-toggle'
```

Add the component next to `TriggerButton` in the header's action row:

```tsx
        <TriggerButton fn={fn} />
        <AutoTraceToggle fn={fn} />
        <TriggerToggle fn={fn} />
```

- [ ] **Step 8: Add a test to `function-header.test.tsx`**

```tsx
it('shows the auto-trace toggle for a Node function but not for a non-Node one', () => {
  const { rerender } = render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(screen.getByText('Auto-trace')).toBeInTheDocument()
  rerender(<FunctionHeader fn={{ ...fn, runtime: 'python' }} onDeleted={() => {}} />)
  expect(screen.queryByText('Auto-trace')).not.toBeInTheDocument()
})
```

(Check this file's existing top-level `fn` const and `makeWrapper` helper name match what's used here — they were already established by earlier tests in this file; use the actual names, don't reintroduce new ones.)

- [ ] **Step 9: Run the full web suite and typecheck**

Run: `npm --prefix web run test && npm --prefix web run typecheck`
Expected: PASS, clean

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/types.ts web/src/components/auto-trace-toggle.tsx web/src/components/auto-trace-toggle.test.tsx \
  web/src/components/function-header.tsx web/src/components/function-header.test.tsx \
  web/src/components/env-editor.test.tsx web/src/components/app-sidebar.test.tsx \
  web/src/components/settings-dialog.test.tsx web/src/components/trigger-toggle.test.tsx \
  web/src/components/event-panel.test.tsx web/src/components/trigger-button.test.tsx \
  web/src/routes/index.test.tsx
git commit -m "feat(web): add a per-function auto-trace toggle for Node functions"
```

---

## Task 7: End-to-end fixture — plain CommonJS handler, no OTel code

**Files:**
- Create: `fixtures/javascript/auto-trace-http/index.js`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is plain JavaScript with no OTel imports at all, proving the point that no handler code changes are needed.
- Produces: `exports.handler`, used by Task 8's end-to-end test.

- [ ] **Step 1: Write the fixture**

Create `fixtures/javascript/auto-trace-http/index.js`:

```js
// Sample handler with NO OpenTelemetry code at all -- demonstrates
// aws-playground's Node auto-tracing feature: enable "Auto-trace" on this
// function (Node-only functions get the toggle) and this http.get call
// gets a real captured span with zero code changes here. Deliberately
// plain CommonJS (require/exports.handler, no build step) since
// auto-instrumentation patches libraries via CommonJS's require() -- see
// docs/superpowers/specs/2026-08-30-node-auto-tracing-design.md for why
// that's a real constraint, not an arbitrary style choice.
const http = require('http');

exports.handler = async (event) => {
  const url = event.url;
  const body = await new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  return { ok: true, body };
};
```

- [ ] **Step 2: Commit**

```bash
git add fixtures/javascript/auto-trace-http/index.js
git commit -m "test: add a plain CommonJS fixture with no OTel code, for the auto-trace e2e test"
```

---

## Task 8: End-to-end test — auto-instrumentation captures a real span

**Files:**
- Test: `tests/harness-node-autotrace.test.js`

**Interfaces:**
- Consumes: `fixtures/javascript/auto-trace-http` (Task 7), `server/invoker.js`'s `invoke()` with `autoTrace: true` (Task 4), the real `server/trace-receiver.js`/`server/trace-collector.js` (already merged, from the invoke-tracing feature).

This is the proof that the whole feature actually works end to end — a handler with zero OTel code, invoked through the real `invoke()` function with `autoTrace: true`, produces a real captured HTTP span.

- [ ] **Step 1: Write the failing test**

Create `tests/harness-node-autotrace.test.js`, mirroring `tests/harness-node-otel.test.js`'s structure but going through the real `invoke()` (not a manually-spawned harness process, since the whole point here is proving `invoke()`'s own `--require` injection works, not just the bootstrap file in isolation):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-autotrace-e2e-'));
const { invoke } = require('../server/invoker');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'javascript', 'auto-trace-http');

function withTestServer(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { res.end('pong'); });
    server.listen(0, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      try {
        resolve(await fn(url));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('a plain CommonJS handler with no OTel code gets a real auto-instrumented span', async () => {
  await withTestServer(async (url) => {
    const r = await invoke({
      id: 'fn-autotrace-e2e', name: 'autotrace-e2e', dir: FIXTURE, runtime: 'node',
      handler: 'index.handler', event: { url }, autoTrace: true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.response.body, 'pong');
    assert.ok(r.trace.spans.length >= 1, `expected at least one auto-instrumented span, got ${r.trace.spans.length}`);
    const httpSpan = r.trace.spans.find((s) => s.name === 'GET');
    assert.ok(httpSpan, `expected a span named "GET" from the http instrumentation, got names: ${r.trace.spans.map((s) => s.name).join(', ')}`);
  });
});

test('the same handler with autoTrace off produces no spans', async () => {
  await withTestServer(async (url) => {
    const r = await invoke({
      id: 'fn-autotrace-off-e2e', name: 'autotrace-off-e2e', dir: FIXTURE, runtime: 'node',
      handler: 'index.handler', event: { url }, autoTrace: false,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.trace.spans.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harness-node-autotrace.test.js`
Expected: FAIL on the first test — `r.trace.spans.length` is `0`, not `>= 1` (Task 4's wiring only fires when all three tasks 1, 2, and 4 landed correctly; if this fails even after those, it's a real integration bug to fix, not a test-authoring problem).

- [ ] **Step 3: Run it — it should already pass if Tasks 1-7 are done correctly**

There's no new production code to write for this task — it's purely an integration test proving the pieces built in Tasks 1-7 fit together. If it fails, debug against the actual chain: confirm `hasOwnTracingSetup(FIXTURE)` returns `false` (the fixture has no `package.json` at all, so it should), confirm `command()` actually receives `['--require', AUTO_TRACE_BOOTSTRAP]`, confirm the bootstrap loads without throwing (Task 2's own test already covers this in isolation), confirm the harness's flush hook actually calls it (Task 3's test already covers this in isolation).

Run: `node --test tests/harness-node-autotrace.test.js`
Expected: PASS

- [ ] **Step 4: Run the full targeted suite one more time**

Run: `node --test tests/auto-trace-detect.test.js tests/auto-trace-bootstrap.test.js tests/harness-node.test.js tests/harness-node-otel.test.js tests/harness-node-autotrace.test.js tests/invoker.test.js tests/api.test.js tests/trace-receiver.test.js tests/trace-collector.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/harness-node-autotrace.test.js
git commit -m "test: prove Node auto-tracing captures a real span end to end"
```

---

## Task 9: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a section documenting auto-tracing**

Read the README's existing "Trace" section first (added by the earlier invoke-tracing feature) to match its heading level and tone. Add a subsection covering:
- What the "Auto-trace" toggle does and where it appears (Node functions only, next to the trigger controls in the function header).
- That it's skipped entirely — not layered on top — for a project that already declares its own `@opentelemetry/sdk-trace*` dependency.
- The CommonJS constraint: only handlers Node loads as CommonJS (hand-written `.cjs`/`.js` without `"type": "module"`, or a build step that compiles to CJS output, like esbuild's default — which is what every existing TypeScript fixture in this repo already produces) actually get auto-traced; a native ES module handler runs fine but gets zero auto-instrumented spans.
- A pointer to `fixtures/javascript/auto-trace-http` as a working example.

- [ ] **Step 2: Proofread against the spec**

Re-read the new section next to `docs/superpowers/specs/2026-08-30-node-auto-tracing-design.md`'s "Scope decisions" and "Error handling & edge cases" sections and confirm nothing drifted from what was actually implemented in Tasks 1-8. This step matters — an earlier iteration of this project's own README drifted from an already-implemented design decision and the mismatch wasn't caught until a final whole-branch review; don't repeat that.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Node auto-tracing, its CommonJS constraint, and the example fixture"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test` (both `test:server` and `test:web`) — if `test:server`'s full run is impractical in the execution environment (a real, pre-existing issue in some sandboxes: `tests/trigger-docker.test.js` can hang indefinitely with no real Docker daemon available, unrelated to this plan), run every test file except that one instead:
`node --test --test-concurrency=1 $(ls tests/*.test.js | grep -v trigger-docker)` plus `npm --prefix web run test`.
Expected: PASS

- [ ] **Step 2: Run the web typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: succeeds, `web/dist/server/server.js` exists afterward.

- [ ] **Step 4: Manually smoke-test**

Start the playground, register `fixtures/javascript/auto-trace-http` (runtime `node`, handler `index.handler`), turn on its "Auto-trace" toggle, and invoke it with `{"url": "https://example.com"}` (or any reachable URL — a local test server if offline). Confirm the Trace tab shows a real `GET` span with no OTel code anywhere in the fixture's source. Then turn "Auto-trace" off and invoke again — confirm the Trace tab goes back to its empty state.

- [ ] **Step 5: Report results**

Summarize: test suite status, build status, and the outcome of the manual smoke test.
