# TanStack Start + shadcn/ui Frontend Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vanilla-JS/Express frontend with a TanStack Start + shadcn/ui app (split-pane UI, persistent invoke history, command palette), with Start owning the whole server.

**Architecture:** The Express route logic is first extracted into a framework-agnostic `server/api.js` (plain functions returning `{status, body}`), which both the temporary Express adapter and the new Start server routes call. A new `server/history.js` persists invokes as JSONL. The Start app lives in `web/` (TypeScript, Tailwind v4, shadcn/ui, TanStack Query, CodeMirror 6) and builds to `web/dist/` — static client assets in `dist/client` plus a fetch-handler server module at `dist/server/server.js` (Start 1.168's Vite build no longer emits a self-running Nitro server; discovered in Task 4). A small dependency-free Node runner (`server/serve-web.js`) serves both, and the CLI starts it in-process. The final task deletes Express and `public/`.

**Tech Stack:** TanStack Start ^1.168, TanStack Router, TanStack Query v5, React 19, Vite 7, Tailwind v4 (`@tailwindcss/vite`), shadcn/ui (new-york, neutral), `@uiw/react-codemirror` + `@codemirror/lang-json`, sonner, lucide-react. Backend modules stay CommonJS.

## Global Constraints

- Node `>=22.12.0` is required to build/run the web app (TanStack Start engine floor). Root `engines.node` is bumped in Task 13 only.
- Spec: `docs/superpowers/specs/2026-07-18-tanstack-start-shadcn-ui-design.md`.
- Existing modules `server/store.js`, `server/detect.js`, `server/invoker.js` must NOT be modified.
- All root tests run with `node --test tests/*.test.js` (no new test frameworks at root; no vitest).
- History: max **50** entries per function; per-field cap **64 KB** (`64 * 1024` bytes); files at `<dataDir>/history/<functionId>.jsonl`.
- Server binds `127.0.0.1` only (loopback hardening must survive the migration).
- Default port stays **4590**.
- Commit after every task with the exact message given (append the repo's standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer).
- The app must remain fully working after every task (Express keeps serving the old UI until Task 13 cuts over).
- Out of scope: request tabs, streaming logs, multi-invoke, request cancellation.

## Known risks / adaptations

If one of these bites, adapt and note it in the commit body — do not silently drop a requirement:

- `resolve: { tsconfigPaths: true }` in `vite.config.ts` comes from the official Start scaffold docs. If the installed Vite rejects it, install `vite-tsconfig-paths` and use `tsconfigPaths()` as the first plugin instead.
- Flat server-route files `api.functions.ts` + `api.functions.$id.ts` create parent/child nesting in the route tree. Handlers match exact paths so this should be fine; if the parent intercepts child requests, rename `api.functions.ts` → `api.functions.index.ts` (route `/api/functions/`) and adjust the client to call `/api/functions/` — or keep the path and register handlers on the parent only for its exact path.
- `npx shadcn@latest add …` needs `components.json` to exist (Task 4 writes it by hand, so no interactive `init` is needed). If the CLI still prompts, re-run with `-y`.

---

### Task 1: Extract `server/api.js`; retarget api tests; Express becomes a thin adapter

**Files:**
- Create: `server/api.js`
- Modify: `server/index.js` (full rewrite, keeps `createApp()` export)
- Modify: `tests/api.test.js` (full rewrite — direct handler calls, no HTTP)

**Interfaces:**
- Consumes: `store.list/get/create/update/remove`, `detectProject(dir)`, `findJar(dir)`, `invoke(opts)` (returns `{ok, phase, response?, error?, logs, report}`).
- Produces (used by Tasks 3, 6 adapter, and Start routes in Task 6):
  - `async health() -> {status: 200, body: {runtimes: {python, node, java}}}`
  - `listFunctions() -> {status: 200, body: {functions: []}}`
  - `createFunction(input) -> {status: 201|400, body}`
  - `updateFunction(id, patch) -> {status: 200|404, body}`
  - `deleteFunction(id) -> {status: 204|404, body?}`
  - `detect(input) -> {status: 200|400, body}`
  - `async invokeFunction(input) -> {status: 200|404|409|500, body}`
  - Handlers never throw for expected failures; `{status:204}` has no `body`.

- [ ] **Step 1: Rewrite `tests/api.test.js` to call handlers directly (failing first)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-api-'));
const api = require('../server/api');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');

test('health reports runtimes', async () => {
  const { status, body } = await api.health();
  assert.strictEqual(status, 200);
  assert.ok('python' in body.runtimes);
  assert.ok('node' in body.runtimes);
  assert.ok('java' in body.runtimes);
  assert.strictEqual(body.runtimes.node.available, true);
});

test('function CRUD with validation', async () => {
  let r = api.createFunction({ name: 'x' });
  assert.strictEqual(r.status, 400);
  r = api.createFunction({ name: 'x', path: FIXTURES, runtime: 'ruby' });
  assert.strictEqual(r.status, 400);
  r = api.createFunction({ name: 'x', path: '/no/such/dir', runtime: 'python' });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'hello', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;

  r = api.listFunctions();
  assert.ok(r.body.functions.some(f => f.id === id));

  r = api.updateFunction(id, { timeoutMs: 5000 });
  assert.strictEqual(r.body.timeoutMs, 5000);
  r = api.updateFunction('missing', {});
  assert.strictEqual(r.status, 404);

  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 204);
  r = api.deleteFunction(id);
  assert.strictEqual(r.status, 404);
});

test('detect endpoint logic', () => {
  let r = api.detect({});
  assert.strictEqual(r.status, 400);
  r = api.detect({ path: path.join(FIXTURES, 'python-hello') });
  assert.strictEqual(r.body.runtime, 'python');
  assert.deepStrictEqual(r.body.handlerCandidates, ['app.handler']);
});

test('invoke returns result; unknown id 404', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hello2', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  const r = await api.invokeFunction({ functionId: created.body.id, event: { q: 7 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { q: 7 });
  assert.ok(r.body.report.requestId);
  const nf = await api.invokeFunction({ functionId: 'missing', event: {} });
  assert.strictEqual(nf.status, 404);
});

test('second concurrent invoke of same function -> 409', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'slow', path: path.join(FIXTURES, 'python-timeout'),
    runtime: 'python', handler: 'app.handler', timeoutMs: 3000 });
  const first = api.invokeFunction({ functionId: created.body.id, event: {} });
  await new Promise(r => setTimeout(r, 300));
  const second = await api.invokeFunction({ functionId: created.body.id, event: {} });
  assert.strictEqual(second.status, 409);
  const done = await first;
  assert.strictEqual(done.body.error.type, 'Sandbox.Timedout');
});
```

Note: the old `serves the frontend statically` test is intentionally dropped here; static serving is covered by `tests/frontend.test.js` until Task 13, then by `tests/web.test.js`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/api.test.js`
Expected: FAIL — `Cannot find module '../server/api'`

- [ ] **Step 3: Create `server/api.js`**

```js
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject } = require('./detect');
const { findJar } = require('./detect');
const { invoke } = require('./invoker');

const RUNTIMES = ['python', 'node', 'java'];
const inFlight = new Set();

function checkRuntime(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

async function health() {
  const [python, node, java] = await Promise.all([
    checkRuntime('python3', ['--version']),
    checkRuntime('node', ['--version']),
    checkRuntime('java', ['-version']),
  ]);
  return { status: 200, body: { runtimes: { python, node, java } } };
}

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

function createFunction(input) {
  const { name, path: dir, runtime } = input || {};
  if (!name || !dir || !runtime) {
    return { status: 400, body: { error: 'name, path and runtime are required' } };
  }
  if (!RUNTIMES.includes(runtime)) {
    return { status: 400, body: { error: `unsupported runtime '${runtime}'` } };
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { status: 400, body: { error: `path is not a directory: ${dir}` } };
  }
  return { status: 201, body: store.create(input) };
}

function updateFunction(id, patch) {
  const fn = store.update(id, patch || {});
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: fn };
}

function deleteFunction(id) {
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  return { status: 204 };
}

function detect(input) {
  const dir = (input || {}).path;
  if (!dir) return { status: 400, body: { error: 'path is required' } };
  return { status: 200, body: detectProject(dir) };
}

async function invokeFunction(input) {
  const { functionId } = input || {};
  const fn = store.get(functionId);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  if (inFlight.has(fn.id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  inFlight.add(fn.id);
  try {
    const result = await invoke({
      name: fn.name,
      dir: fn.path,
      runtime: fn.runtime,
      handler: input.handler ?? fn.handler,
      event: input.event ?? {},
      env: { ...fn.env, ...(input.envVars || {}) },
      timeoutMs: input.timeoutMs ?? fn.timeoutMs,
      memoryMb: input.memoryMb ?? fn.memoryMb,
      jarPath: fn.jarPath || findJar(fn.path),
    });
    return { status: 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    inFlight.delete(fn.id);
  }
}

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, RUNTIMES };
```

- [ ] **Step 4: Rewrite `server/index.js` as a thin Express adapter (old UI keeps working)**

```js
const express = require('express');
const path = require('path');
const api = require('./api');

function send(res, result) {
  if (result.status === 204) return res.status(204).end();
  res.status(result.status).json(result.body);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', async (req, res) => send(res, await api.health()));
  app.get('/api/functions', (req, res) => send(res, api.listFunctions()));
  app.post('/api/functions', (req, res) => send(res, api.createFunction(req.body || {})));
  app.patch('/api/functions/:id', (req, res) => send(res, api.updateFunction(req.params.id, req.body || {})));
  app.delete('/api/functions/:id', (req, res) => send(res, api.deleteFunction(req.params.id)));
  app.post('/api/detect', (req, res) => send(res, api.detect(req.body || {})));
  app.post('/api/invoke', async (req, res) => send(res, await api.invokeFunction(req.body || {})));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp };
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (api tests now direct; frontend/store/detect/invoker/harness tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/api.js server/index.js tests/api.test.js
git commit -m "refactor: extract framework-agnostic server/api.js from Express"
```

---

### Task 2: `server/history.js` (persistent invoke history)

**Files:**
- Create: `server/history.js`
- Create: `tests/history.test.js`

**Interfaces:**
- Consumes: `store.dataDir()`.
- Produces (used by Task 3):
  - `append(functionId, entry) -> storedEntry` — entry fields: `{handler, event, response, error, logs, report, durationMs, ok}`; stored entry adds `{id, ts, truncated}`.
  - `list(functionId) -> storedEntry[]` newest first; `[]` when no file.
  - `clear(functionId) -> boolean`.
  - Constants `MAX_ENTRIES = 50`, `MAX_FIELD_BYTES = 65536`.
  - Storage: `<dataDir>/history/<functionId>.jsonl`, one JSON object per line, oldest first on disk.

- [ ] **Step 1: Write `tests/history.test.js` (failing first)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-hist-'));
const history = require('../server/history');

function entry(overrides = {}) {
  return { handler: 'app.handler', event: { a: 1 }, response: { ok: 1 },
    error: null, logs: 'line\n', report: { requestId: 'r', durationMs: 5 },
    durationMs: 5, ok: true, ...overrides };
}

test('append and list round-trip, newest first', () => {
  history.append('fn1', entry({ logs: 'first' }));
  history.append('fn1', entry({ logs: 'second' }));
  const entries = history.list('fn1');
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].logs, 'second');
  assert.strictEqual(entries[1].logs, 'first');
  assert.ok(entries[0].id);
  assert.ok(entries[0].ts > 0);
  assert.strictEqual(entries[0].ok, true);
  assert.deepStrictEqual(entries[0].event, { a: 1 });
});

test('list of unknown function is empty', () => {
  assert.deepStrictEqual(history.list('nope'), []);
});

test('cap at MAX_ENTRIES, oldest trimmed', () => {
  for (let i = 0; i < history.MAX_ENTRIES + 7; i++) {
    history.append('fn2', entry({ logs: `run-${i}` }));
  }
  const entries = history.list('fn2');
  assert.strictEqual(entries.length, history.MAX_ENTRIES);
  assert.strictEqual(entries[0].logs, `run-${history.MAX_ENTRIES + 6}`);
  assert.strictEqual(entries[entries.length - 1].logs, 'run-7');
});

test('oversized fields are truncated and flagged', () => {
  const big = 'x'.repeat(history.MAX_FIELD_BYTES + 1000);
  const stored = history.append('fn3', entry({ logs: big, event: { blob: big } }));
  assert.strictEqual(stored.truncated, true);
  assert.ok(Buffer.byteLength(stored.logs, 'utf8') <= history.MAX_FIELD_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.event), 'utf8') <= history.MAX_FIELD_BYTES + 16);
  const listed = history.list('fn3')[0];
  assert.strictEqual(listed.truncated, true);
});

test('small entries are not flagged truncated', () => {
  const stored = history.append('fn4', entry());
  assert.strictEqual(stored.truncated, false);
});

test('clear removes the file', () => {
  history.append('fn5', entry());
  assert.strictEqual(history.clear('fn5'), true);
  assert.deepStrictEqual(history.list('fn5'), []);
  assert.strictEqual(history.clear('fn5'), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/history.test.js`
Expected: FAIL — `Cannot find module '../server/history'`

- [ ] **Step 3: Create `server/history.js`**

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./store');

const MAX_ENTRIES = 50;
const MAX_FIELD_BYTES = 64 * 1024;

function fileFor(functionId) {
  return path.join(dataDir(), 'history', `${functionId}.jsonl`);
}

function capString(s) {
  if (typeof s !== 'string' || Buffer.byteLength(s, 'utf8') <= MAX_FIELD_BYTES) {
    return { value: s, truncated: false };
  }
  const cut = Buffer.from(s, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  return { value: cut, truncated: true };
}

// Oversized structured values are replaced by a truncated JSON-string preview.
function capJson(value) {
  const str = JSON.stringify(value);
  if (str === undefined || Buffer.byteLength(str, 'utf8') <= MAX_FIELD_BYTES) {
    return { value, truncated: false };
  }
  const cut = Buffer.from(str, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  return { value: cut, truncated: true };
}

function list(functionId) {
  let raw;
  try {
    raw = fs.readFileSync(fileFor(functionId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out.reverse();
}

function append(functionId, entry) {
  const logs = capString(entry.logs ?? '');
  const event = capJson(entry.event);
  const response = capJson(entry.response);
  const stored = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    handler: entry.handler ?? '',
    event: event.value,
    response: response.value,
    error: entry.error ?? null,
    logs: logs.value,
    report: entry.report ?? null,
    durationMs: entry.durationMs ?? null,
    ok: !!entry.ok,
    truncated: logs.truncated || event.truncated || response.truncated,
  };
  const oldestFirst = list(functionId).reverse();
  oldestFirst.push(stored);
  const keep = oldestFirst.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(fileFor(functionId)), { recursive: true });
  fs.writeFileSync(fileFor(functionId), keep.map(e => JSON.stringify(e)).join('\n') + '\n');
  return stored;
}

function clear(functionId) {
  try {
    fs.rmSync(fileFor(functionId));
    return true;
  } catch {
    return false;
  }
}

module.exports = { append, list, clear, MAX_ENTRIES, MAX_FIELD_BYTES };
```

- [ ] **Step 4: Run to verify pass, then full suite**

Run: `node --test tests/history.test.js` → all pass. Then `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server/history.js tests/history.test.js
git commit -m "feat: persistent invoke history module (JSONL, 50-entry cap, 64KB field cap)"
```

---

### Task 3: Wire history into the API (record on invoke, list/clear endpoints)

**Files:**
- Modify: `server/api.js`
- Modify: `server/index.js` (two new Express routes)
- Modify: `tests/api.test.js` (new tests appended)

**Interfaces:**
- Produces (used by Start routes in Task 6 and the History UI in Task 11):
  - `listHistory(functionId) -> {status: 200, body: {entries}} | {status: 404, body: {error}}`
  - `clearHistory(functionId) -> {status: 204} | {status: 404, body: {error}}`
  - `invokeFunction` now records every completed invoke (2xx result, success or handler error) into history; transport-level 404/409 records nothing.
  - `deleteFunction` clears the function's history.

- [ ] **Step 1: Append failing tests to `tests/api.test.js`**

```js
test('invoke records history; delete clears it', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hist', path: path.join(FIXTURES, 'python-hello'),
    runtime: 'python', handler: 'app.handler' });
  const id = created.body.id;

  let h = api.listHistory(id);
  assert.strictEqual(h.status, 200);
  assert.deepStrictEqual(h.body.entries, []);

  await api.invokeFunction({ functionId: id, event: { q: 1 } });
  h = api.listHistory(id);
  assert.strictEqual(h.body.entries.length, 1);
  assert.strictEqual(h.body.entries[0].ok, true);
  assert.deepStrictEqual(h.body.entries[0].event, { q: 1 });
  assert.ok(h.body.entries[0].report.requestId);

  const cleared = api.clearHistory(id);
  assert.strictEqual(cleared.status, 204);
  assert.deepStrictEqual(api.listHistory(id).body.entries, []);

  await api.invokeFunction({ functionId: id, event: {} });
  api.deleteFunction(id);
  assert.strictEqual(api.listHistory(id).status, 404);
  const history = require('../server/history');
  assert.deepStrictEqual(history.list(id), []);
});

test('history endpoints 404 for unknown function', () => {
  assert.strictEqual(api.listHistory('missing').status, 404);
  assert.strictEqual(api.clearHistory('missing').status, 404);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/api.test.js`
Expected: FAIL — `api.listHistory is not a function`

- [ ] **Step 3: Implement in `server/api.js`**

Add at top: `const history = require('./history');`

In `deleteFunction`, before `return { status: 204 }` (after the remove succeeded):

```js
function deleteFunction(id) {
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}
```

In `invokeFunction`, replace `return { status: 200, body: result };` with:

```js
    history.append(fn.id, {
      handler: input.handler ?? fn.handler,
      event: input.event ?? {},
      response: result.response,
      error: result.error ?? null,
      logs: result.logs,
      report: result.report,
      durationMs: result.report.durationMs,
      ok: result.ok,
    });
    return { status: 200, body: result };
```

Add the two handlers and export them:

```js
function listHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: { entries: history.list(functionId) } };
}

function clearHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  history.clear(functionId);
  return { status: 204 };
}

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory, RUNTIMES };
```

- [ ] **Step 4: Expose in the Express adapter (`server/index.js`), after the DELETE functions route**

```js
  app.get('/api/functions/:id/history', (req, res) => send(res, api.listHistory(req.params.id)));
  app.delete('/api/functions/:id/history', (req, res) => send(res, api.clearHistory(req.params.id)));
```

- [ ] **Step 5: Run full suite**

Run: `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add server/api.js server/index.js tests/api.test.js
git commit -m "feat: record invoke history and expose list/clear history endpoints"
```

---

### Task 4: Scaffold the TanStack Start app in `web/` with Tailwind v4 + shadcn

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/components.json`, `web/src/router.tsx`, `web/src/routes/__root.tsx`, `web/src/routes/index.tsx`, `web/src/styles.css`, `web/src/lib/utils.ts`
- Modify: `.gitignore`

No root tests cover this task; verification is build output + dev-server boot.

- [ ] **Step 1: Write `web/package.json`**

```json
{
  "name": "aws-playground-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@codemirror/lang-json": "^6.0.2",
    "@tanstack/react-query": "^5.90.0",
    "@tanstack/react-router": "^1.168.0",
    "@tanstack/react-start": "^1.168.0",
    "@uiw/react-codemirror": "^4.25.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.545.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "sonner": "^2.0.7",
    "tailwind-merge": "^3.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@types/node": "^24.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.1.0",
    "tw-animate-css": "^1.4.0",
    "typescript": "^5.9.0",
    "vite": "^7.1.0"
  }
}
```

- [ ] **Step 2: Write `web/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: { port: 4590 },
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
```

- [ ] **Step 3: Write `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 4: Write `web/components.json`** (hand-written so `shadcn add` never needs interactive init)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 5: Write `web/src/styles.css`** (Tailwind v4 + shadcn neutral tokens)

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.5rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --font-sans: ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 6: Write `web/src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 7: Write `web/src/router.tsx`**

```tsx
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true })
}
```

- [ ] **Step 8: Write `web/src/routes/__root.tsx`**

```tsx
import type { ReactNode } from 'react'
import { Outlet, createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Lambda Playground' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

- [ ] **Step 9: Write placeholder `web/src/routes/index.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  return <div className="p-8 text-xl font-semibold">Lambda Playground</div>
}
```

- [ ] **Step 10: Update `.gitignore`** — append:

```
web/node_modules/
web/.output/
web/.nitro/
web/.tanstack/
web/src/routeTree.gen.ts
```

- [ ] **Step 11: Install and add shadcn components**

```bash
cd web && npm install
npx shadcn@latest add -y button badge input label select dialog sheet tabs collapsible separator scroll-area tooltip alert-dialog dropdown-menu command resizable sonner
```

Expected: components appear under `web/src/components/ui/`; radix/cmdk/react-resizable-panels deps added to `web/package.json`.

- [ ] **Step 12: Verify build and dev boot**

```bash
cd web && npm run build
ls .output/server/index.mjs        # must exist
PORT=4591 HOST=127.0.0.1 node .output/server/index.mjs &
sleep 2 && curl -s http://127.0.0.1:4591/ | grep -o 'Lambda Playground' && kill %1
```

Expected: build succeeds, `Lambda Playground` printed.

- [ ] **Step 13: Commit**

```bash
git add web .gitignore
git commit -m "feat: scaffold TanStack Start app with Tailwind v4 and shadcn/ui"
```

---

### Task 5: Frontend foundation — types, API client, query hooks, theme, providers

**Files:**
- Create: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/queries.ts`, `web/src/lib/theme.tsx`, `web/src/components/theme-toggle.tsx`
- Modify: `web/src/routes/__root.tsx`

**Interfaces:**
- Produces (used by every UI task):
  - Types: `Runtime`, `FunctionDef`, `Health`, `Detection`, `InvokeResult`, `HistoryEntry`, `SavedEvent`, `Report`, `LambdaError`.
  - `api.*` client methods (health, listFunctions, createFunction, updateFunction, deleteFunction, detect, invoke, listHistory, clearHistory); throws `ApiError {status, message}` on non-2xx.
  - Hooks: `useFunctions()`, `useHealth()`, `useHistoryQuery(id)`, `useCreateFunction()`, `useUpdateFunction()`, `useDeleteFunction()`, `useInvoke()`, `useClearHistory()`.
  - `ThemeProvider` + `useTheme()` (`'light' | 'dark'`, persisted to `localStorage['awsplay-theme']`, `.dark` class on `<html>`).

- [ ] **Step 1: Write `web/src/lib/types.ts`**

```ts
export type Runtime = 'python' | 'node' | 'java'

export interface SavedEvent {
  name: string
  event: unknown
}

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
  savedEvents: SavedEvent[]
}

export interface RuntimeHealth {
  available: boolean
  version: string | null
}

export interface Health {
  runtimes: Record<Runtime, RuntimeHealth>
}

export interface Detection {
  error?: string
  runtime: Runtime | null
  handlerCandidates: string[]
  venvPython?: string | null
  jarPath?: string | null
}

export interface LambdaError {
  type: string
  message: string
  stackTrace: string[]
}

export interface Report {
  requestId: string
  durationMs: number
  billedMs: number
  memoryMb: number
  timedOut: boolean
}

export interface InvokeResult {
  ok: boolean
  phase: 'init' | 'invoke'
  response?: unknown
  error?: LambdaError
  logs: string
  report: Report
}

export interface HistoryEntry {
  id: string
  ts: number
  handler: string
  event: unknown
  response?: unknown
  error?: LambdaError | null
  logs: string
  report: Report | null
  durationMs: number | null
  ok: boolean
  truncated: boolean
}
```

- [ ] **Step 2: Write `web/src/lib/api.ts`**

```ts
import type { Detection, FunctionDef, Health, HistoryEntry, InvokeResult } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText)
  return body as T
}

export interface InvokePayload {
  functionId: string
  event: unknown
  handler?: string
  envVars?: Record<string, string>
  timeoutMs?: number
  memoryMb?: number
}

export const api = {
  health: () => request<Health>('/api/health'),
  listFunctions: () => request<{ functions: FunctionDef[] }>('/api/functions'),
  createFunction: (input: Partial<FunctionDef>) =>
    request<FunctionDef>('/api/functions', { method: 'POST', body: JSON.stringify(input) }),
  updateFunction: (id: string, patch: Partial<FunctionDef>) =>
    request<FunctionDef>(`/api/functions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteFunction: (id: string) =>
    request<void>(`/api/functions/${id}`, { method: 'DELETE' }),
  detect: (path: string) =>
    request<Detection>('/api/detect', { method: 'POST', body: JSON.stringify({ path }) }),
  invoke: (payload: InvokePayload) =>
    request<InvokeResult>('/api/invoke', { method: 'POST', body: JSON.stringify(payload) }),
  listHistory: (id: string) =>
    request<{ entries: HistoryEntry[] }>(`/api/functions/${id}/history`),
  clearHistory: (id: string) =>
    request<void>(`/api/functions/${id}/history`, { method: 'DELETE' }),
}
```

- [ ] **Step 3: Write `web/src/lib/queries.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type InvokePayload } from './api'
import type { FunctionDef } from './types'

export function useFunctions() {
  return useQuery({
    queryKey: ['functions'],
    queryFn: api.listFunctions,
    select: (d) => d.functions,
  })
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
}

export function useHistoryQuery(id: string | null) {
  return useQuery({
    queryKey: ['history', id],
    queryFn: () => api.listHistory(id!),
    enabled: !!id,
    select: (d) => d.entries,
  })
}

function onApiError(err: Error) {
  toast.error(err.message)
}

export function useCreateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<FunctionDef>) => api.createFunction(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['functions'] }),
  })
}

export function useUpdateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<FunctionDef> }) =>
      api.updateFunction(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['functions'] }),
    onError: onApiError,
  })
}

export function useDeleteFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteFunction(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['functions'] }),
    onError: onApiError,
  })
}

export function useInvoke() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: InvokePayload) => api.invoke(payload),
    onSuccess: (_r, payload) =>
      qc.invalidateQueries({ queryKey: ['history', payload.functionId] }),
    onError: onApiError,
  })
}

export function useClearHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.clearHistory(id),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: ['history', id] }),
    onError: onApiError,
  })
}
```

- [ ] **Step 4: Write `web/src/lib/theme.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'
const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'light',
  toggle: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    const stored = localStorage.getItem('awsplay-theme') as Theme | null
    const preferred =
      stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    setTheme(preferred)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const toggle = () => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem('awsplay-theme', next)
      return next
    })
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
```

- [ ] **Step 5: Write `web/src/components/theme-toggle.tsx`**

```tsx
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/lib/theme'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
```

- [ ] **Step 6: Wire providers into `web/src/routes/__root.tsx`** — replace `RootComponent` and imports:

```tsx
import type { ReactNode } from 'react'
import { Outlet, createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/lib/theme'
import appCss from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Lambda Playground' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Outlet />
          <Toaster richColors />
        </ThemeProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

- [ ] **Step 7: Verify**

```bash
cd web && npm run typecheck && npm run build
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat: web foundation - types, api client, query hooks, theme provider"
```

---

### Task 6: Start server routes adapting `server/api.js` + Node runner + built-server smoke test

**Files:**
- Create: `web/src/lib/backend.ts`, `web/src/routes/api.health.ts`, `web/src/routes/api.functions.ts`, `web/src/routes/api.functions.$id.ts`, `web/src/routes/api.functions.$id.history.ts`, `web/src/routes/api.detect.ts`, `web/src/routes/api.invoke.ts`
- Create: `server/serve-web.js` (Node runner for the built app)
- Create: `tests/web.test.js`

**Interfaces:**
- Consumes: every `server/api.js` handler from Tasks 1 & 3; the built output at `web/dist` (`dist/client` static assets, `dist/server/server.js` exporting a `{ fetch(Request): Promise<Response> }` server entry).
- Produces: HTTP endpoints identical to the Express adapter (same paths, methods, status codes, JSON bodies) served by the Start server in dev (`vite dev`), and `startWebServer({ distDir, port, host }) -> Promise<http.Server>` from `server/serve-web.js` (used by Task 13's CLI and by the smoke test; `port: 0` picks an ephemeral port).

- [ ] **Step 1: Write `web/src/lib/backend.ts`** (server-only bridge to the CJS modules)

```ts
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// Works from web/src/lib (dev) and web/.output/server (built): walk up
// until the repo's server/ directory is found.
function serverDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'server', 'api.js'))) return path.join(dir, 'server')
    dir = path.dirname(dir)
  }
  throw new Error('could not locate server/api.js relative to the web build')
}

const req = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const backend: any = req(path.join(serverDir(), 'api.js'))

export function toResponse(result: { status: number; body?: unknown }): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status })
  }
  return Response.json(result.body, { status: result.status })
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => ({}))
}
```

- [ ] **Step 2: Write the six route files**

`web/src/routes/api.health.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => toResponse(await backend.health()),
    },
  },
})
```

`web/src/routes/api.functions.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions')({
  server: {
    handlers: {
      GET: async () => toResponse(backend.listFunctions()),
      POST: async ({ request }) => toResponse(backend.createFunction(await jsonBody(request))),
    },
  },
})
```

`web/src/routes/api.functions.$id.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        toResponse(backend.updateFunction(params.id, await jsonBody(request))),
      DELETE: async ({ params }) => toResponse(backend.deleteFunction(params.id)),
    },
  },
})
```

`web/src/routes/api.functions.$id.history.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id/history')({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(backend.listHistory(params.id)),
      DELETE: async ({ params }) => toResponse(backend.clearHistory(params.id)),
    },
  },
})
```

`web/src/routes/api.detect.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/detect')({
  server: {
    handlers: {
      POST: async ({ request }) => toResponse(backend.detect(await jsonBody(request))),
    },
  },
})
```

`web/src/routes/api.invoke.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/invoke')({
  server: {
    handlers: {
      POST: async ({ request }) => toResponse(await backend.invokeFunction(await jsonBody(request))),
    },
  },
})
```

- [ ] **Step 3: Write `server/serve-web.js`** (dependency-free Node runner: serves `dist/client` statically, forwards everything else to the fetch handler)

```js
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function staticFile(clientDir, urlPath) {
  const resolved = path.resolve(clientDir, '.' + urlPath);
  if (resolved !== clientDir && !resolved.startsWith(clientDir + path.sep)) return null;
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {}
  return null;
}

async function startWebServer({ distDir, port, host }) {
  const entryUrl = pathToFileURL(path.join(distDir, 'server', 'server.js')).href;
  const clientDir = path.join(distDir, 'client');
  const mod = await import(entryUrl);
  const entry = mod.default ?? mod;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = staticFile(clientDir, urlPath);
        if (file) {
          res.writeHead(200, {
            'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file).pipe(res);
        }
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await entry.fetch(request);
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`aws-playground web server error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

module.exports = { startWebServer };
```

- [ ] **Step 3b: Write `tests/web.test.js` (in-process boot via the runner)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'web', 'dist');
const built = fs.existsSync(path.join(DIST, 'server', 'server.js'));

test('built web app serves the shell and the API',
  { skip: built ? false : 'web/dist missing - run npm run build first' }, async () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-web-'));
  const { startWebServer } = require('../server/serve-web');
  const server = await startWebServer({ distDir: DIST, port: 0, host: '127.0.0.1' });
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.ok(body.runtimes.node.available);

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.ok(html.includes('Lambda Playground'));

    const fns = await fetch(`http://127.0.0.1:${port}/api/functions`);
    assert.deepStrictEqual(await fns.json(), { functions: [] });

    const missing = await fetch(`http://127.0.0.1:${port}/api/functions/nope/history`);
    assert.strictEqual(missing.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 4: Build, then run the smoke test**

```bash
cd web && npm run build && cd ..
node --test tests/web.test.js
```

Expected: PASS (not skipped — the build exists after the first command).

- [ ] **Step 5: Run the full suite**

Run: `npm test` → all pass (web test runs because `.output` now exists).

- [ ] **Step 6: Commit**

```bash
git add web/src server/serve-web.js tests/web.test.js
git commit -m "feat: TanStack Start server routes over server/api.js with Node runner and smoke test"
```

---

### Task 7: App shell — sidebar, header, health chips, add-function dialog

**Files:**
- Create: `web/src/components/app-sidebar.tsx`, `web/src/components/add-function-dialog.tsx`, `web/src/components/health-chips.tsx`
- Modify: `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `useFunctions`, `useHealth`, `useCreateFunction`, `api.detect`, `ThemeToggle`.
- Produces: `<AppSidebar functions selectedId onSelect onAdd />`, `<AddFunctionDialog open onOpenChange onCreated(id) />`, `<HealthChips />`. `index.tsx` owns `selectedId: string | null` state and renders the workspace placeholder for now.

- [ ] **Step 1: Write `web/src/components/health-chips.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHealth } from '@/lib/queries'
import type { Runtime } from '@/lib/types'

const LABELS: Record<Runtime, string> = { python: 'py', node: 'node', java: 'java' }

export function HealthChips() {
  const { data } = useHealth()
  if (!data) return null
  return (
    <div className="flex items-center gap-1.5">
      {(Object.keys(LABELS) as Runtime[]).map((rt) => {
        const info = data.runtimes[rt]
        return (
          <Tooltip key={rt}>
            <TooltipTrigger asChild>
              <Badge variant={info?.available ? 'secondary' : 'outline'}
                className={info?.available ? '' : 'opacity-50 line-through'}>
                {LABELS[rt]}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{info?.version ?? 'not found on PATH'}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Write `web/src/components/add-function-dialog.tsx`**

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { useCreateFunction } from '@/lib/queries'
import type { Runtime } from '@/lib/types'

export function AddFunctionDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [runtime, setRuntime] = useState<Runtime>('python')
  const [handler, setHandler] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [error, setError] = useState('')
  const create = useCreateFunction()

  async function runDetect() {
    if (!dir.trim()) return
    try {
      const d = await api.detect(dir.trim())
      if (d.error) {
        setError(`Not a directory: ${dir.trim()}`)
        return
      }
      setError('')
      if (d.runtime) setRuntime(d.runtime)
      if (!name) setName(dir.trim().split('/').filter(Boolean).pop() ?? '')
      setCandidates(d.handlerCandidates.slice(0, 6))
      if (d.handlerCandidates.length > 0 && !handler) setHandler(d.handlerCandidates[0])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function submit() {
    create.mutate(
      { name: name.trim(), path: dir.trim(), runtime, handler: handler.trim() },
      {
        onSuccess: (fn) => {
          onOpenChange(false)
          setDir(''); setName(''); setHandler(''); setCandidates([]); setError('')
          toast.success(`Registered ${fn.name}`)
          onCreated(fn.id)
        },
        onError: (e) => setError(e.message),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add function</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="fn-path">Project path</Label>
            <Input id="fn-path" value={dir} onChange={(e) => setDir(e.target.value)}
              onBlur={runDetect} placeholder="/absolute/path/to/project"
              spellCheck={false} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fn-name">Name</Label>
            <Input id="fn-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Function name" autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label>Runtime</Label>
            <Select value={runtime} onValueChange={(v) => setRuntime(v as Runtime)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="python">python</SelectItem>
                <SelectItem value="node">node</SelectItem>
                <SelectItem value="java">java</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fn-handler">Handler</Label>
            <Input id="fn-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              placeholder="e.g. app.handler" spellCheck={false} autoComplete="off" />
            {candidates.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {candidates.map((c) => (
                  <Button key={c} type="button" variant="outline" size="sm"
                    onClick={() => setHandler(c)}>
                    {c}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || !dir.trim() || !name.trim()}>
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Write `web/src/components/app-sidebar.tsx`**

```tsx
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { FunctionDef } from '@/lib/types'

export function AppSidebar({ functions, selectedId, onSelect, onAdd }: {
  functions: FunctionDef[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Functions
        </span>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus className="size-4" /> Add
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <ul className="px-2 pb-2">
          {functions.map((fn) => (
            <li key={fn.id}>
              <button
                onClick={() => onSelect(fn.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                  fn.id === selectedId && 'bg-accent font-medium',
                )}
              >
                <span className="truncate">{fn.name}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">{fn.runtime}</Badge>
              </button>
            </li>
          ))}
          {functions.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              No functions yet.
            </li>
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}
```

- [ ] **Step 4: Rewrite `web/src/routes/index.tsx`** (shell layout; workspace arrives in Tasks 8–9)

```tsx
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AddFunctionDialog } from '@/components/add-function-dialog'
import { AppSidebar } from '@/components/app-sidebar'
import { HealthChips } from '@/components/health-chips'
import { ThemeToggle } from '@/components/theme-toggle'
import { useFunctions } from '@/lib/queries'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const { data: functions = [] } = useFunctions()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    if (selectedId && !functions.some((f) => f.id === selectedId)) setSelectedId(null)
    if (!selectedId && functions.length > 0) setSelectedId(functions[0].id)
  }, [functions, selectedId])

  const selected = functions.find((f) => f.id === selectedId) ?? null

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold">λ Lambda Playground</h1>
        <div className="flex items-center gap-3">
          <HealthChips />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <AppSidebar functions={functions} selectedId={selectedId}
          onSelect={setSelectedId} onAdd={() => setAddOpen(true)} />
        <main className="min-w-0 flex-1">
          {selected ? (
            <div className="p-4 text-sm text-muted-foreground">
              Workspace for {selected.name} (coming in the next tasks)
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Register a function to get started.
            </div>
          )}
        </main>
      </div>
      <AddFunctionDialog open={addOpen} onOpenChange={setAddOpen} onCreated={setSelectedId} />
    </div>
  )
}
```

- [ ] **Step 5: Verify in the browser and by build**

```bash
cd web && npm run typecheck && npm run dev
```

Manual check at `http://localhost:4590`: header with health chips and theme toggle; add a function via the dialog using `fixtures/node-apigw` (name/runtime/handler auto-fill after path blur); it appears selected in the sidebar. Stop the dev server; run `npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: app shell - sidebar, header, health chips, add-function dialog"
```

---

### Task 8: Function header, settings sheet, env-vars editor

**Files:**
- Create: `web/src/components/function-header.tsx`, `web/src/components/settings-sheet.tsx`, `web/src/components/env-editor.tsx`
- Modify: `web/src/routes/index.tsx` (render them in the workspace)

**Interfaces:**
- Consumes: `useUpdateFunction`, `useDeleteFunction`.
- Produces: `<FunctionHeader fn onDeleted />` (contains settings + delete), `<EnvEditor fn />`. Both PATCH through `useUpdateFunction`.

- [ ] **Step 1: Write `web/src/components/settings-sheet.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function SettingsSheet({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const update = useUpdateFunction()

  useEffect(() => {
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
  }, [fn])

  function save() {
    update.mutate(
      {
        id: fn.id,
        patch: {
          handler: handler.trim(),
          timeoutMs: Math.max(100, parseInt(timeoutMs, 10) || fn.timeoutMs),
          memoryMb: Math.max(128, parseInt(memoryMb, 10) || fn.memoryMb),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Settings — {fn.name}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 px-4">
          <div className="grid gap-2">
            <Label htmlFor="s-handler">Handler</Label>
            <Input id="s-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-timeout">Timeout (ms)</Label>
            <Input id="s-timeout" type="number" min={100} step={1000} value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-memory">Memory (MB)</Label>
            <Input id="s-memory" type="number" min={128} step={64} value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)} />
          </div>
          {fn.runtime === 'java' && (
            <div className="grid gap-2">
              <Label htmlFor="s-jar">Jar path</Label>
              <Input id="s-jar" value={jarPath} onChange={(e) => setJarPath(e.target.value)}
                spellCheck={false} placeholder="auto-detected if empty" />
            </div>
          )}
        </div>
        <SheetFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Write `web/src/components/function-header.tsx`**

```tsx
import { Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSheet } from '@/components/settings-sheet'
import { useDeleteFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function FunctionHeader({ fn, onDeleted }: { fn: FunctionDef; onDeleted: () => void }) {
  const del = useDeleteFunction()
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <h2 className="truncate text-sm font-semibold">{fn.name}</h2>
      <Badge variant="secondary">{fn.runtime}</Badge>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {fn.handler || 'no handler set'} · {fn.timeoutMs}ms · {fn.memoryMb}MB
      </span>
      <div className="ml-auto flex items-center gap-1">
        <SettingsSheet fn={fn} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Delete function">
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {fn.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the registration and its invoke history. The project folder is untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate(fn.id, { onSuccess: onDeleted })}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Write `web/src/components/env-editor.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { ChevronsUpDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

type Row = { key: string; value: string }

export function EnvEditor({ fn }: { fn: FunctionDef }) {
  const [rows, setRows] = useState<Row[]>([])
  const update = useUpdateFunction()

  useEffect(() => {
    setRows(Object.entries(fn.env).map(([key, value]) => ({ key, value })))
  }, [fn.id, fn.env])

  function save(next: Row[]) {
    setRows(next)
    const env: Record<string, string> = {}
    for (const r of next) if (r.key.trim()) env[r.key.trim()] = r.value
    update.mutate({ id: fn.id, patch: { env } })
  }

  function setRow(i: number, patch: Partial<Row>) {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
    setRows(next)
  }

  return (
    <Collapsible defaultOpen={rows.length > 0} className="border-b px-4 py-2">
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Environment variables ({rows.length}) <ChevronsUpDown className="size-3" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="grid gap-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input className="h-8 font-mono text-xs" placeholder="KEY" value={row.key}
                spellCheck={false} onChange={(e) => setRow(i, { key: e.target.value })}
                onBlur={() => save(rows)} />
              <Input className="h-8 font-mono text-xs" placeholder="value" value={row.value}
                spellCheck={false} onChange={(e) => setRow(i, { value: e.target.value })}
                onBlur={() => save(rows)} />
              <Button variant="ghost" size="icon" className="size-8 shrink-0"
                aria-label="Remove variable"
                onClick={() => save(rows.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-1.5"
          onClick={() => setRows([...rows, { key: '', value: '' }])}>
          <Plus className="size-3.5" /> Add variable
        </Button>
      </CollapsibleContent>
    </Collapsible>
  )
}
```

- [ ] **Step 4: Render in `web/src/routes/index.tsx`** — replace the `selected ? (...)` placeholder block:

```tsx
          {selected ? (
            <div className="flex h-full flex-col">
              <FunctionHeader fn={selected} onDeleted={() => setSelectedId(null)} />
              <EnvEditor fn={selected} />
              <div className="p-4 text-sm text-muted-foreground">
                Invoke workspace (next task)
              </div>
            </div>
          ) : (
```

Add imports:

```tsx
import { EnvEditor } from '@/components/env-editor'
import { FunctionHeader } from '@/components/function-header'
```

- [ ] **Step 5: Verify**

`cd web && npm run typecheck && npm run dev` — edit handler/timeout/memory in the sheet (persists after reload), add/remove env vars, delete a function (confirm dialog, history note). Then `npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: function header with settings sheet, delete confirm, env-vars editor"
```

---

### Task 9: Invoke workspace — split-pane, CodeMirror event editor, templates, saved events, result tabs

**Files:**
- Create: `web/src/lib/templates.ts`, `web/src/components/event-panel.tsx`, `web/src/components/result-panel.tsx`
- Modify: `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `useInvoke`, `useUpdateFunction`, shadcn `resizable` (from `react-resizable-panels`), `@uiw/react-codemirror`.
- Produces:
  - `EVENT_TEMPLATES: Record<string, unknown>` in `templates.ts`.
  - `<EventPanel fn eventText onEventTextChange onInvoke invoking />` — owns template/saved-event pickers and the editor; Invoke disabled while JSON is invalid.
  - `<ResultPanel result />` with `result: InvokeResult | null` — Response / Logs / Report tabs (History added in Task 10 as a fourth tab prop).
  - `index.tsx` owns per-function event drafts (`Record<functionId, string>`) and the latest `InvokeResult`.

- [ ] **Step 1: Write `web/src/lib/templates.ts`** (ported from the old `public/app.js`, plus an HTTP API v2 template)

```ts
export const EVENT_TEMPLATES: Record<string, unknown> = {
  'Empty': {},
  'API Gateway HTTP API v2': {
    version: '2.0', routeKey: 'GET /hello', rawPath: '/hello',
    rawQueryString: 'name=world',
    headers: { accept: '*/*' },
    queryStringParameters: { name: 'world' },
    requestContext: { http: { method: 'GET', path: '/hello' } },
    isBase64Encoded: false,
  },
  'API Gateway proxy (v1)': {
    resource: '/{proxy+}', path: '/hello', httpMethod: 'GET',
    headers: { Accept: '*/*' }, queryStringParameters: { name: 'world' },
    pathParameters: { proxy: 'hello' }, body: null, isBase64Encoded: false,
  },
  'S3 put': { Records: [{ eventVersion: '2.1', eventSource: 'aws:s3',
    awsRegion: 'us-east-1', eventName: 'ObjectCreated:Put',
    s3: { bucket: { name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket' },
      object: { key: 'test/key.txt', size: 1024 } } }] },
  'SQS message': { Records: [{ messageId: '19dd0b57-b21e-4ac1-bd88-01bbb068cb78',
    receiptHandle: 'MessageReceiptHandle', body: 'Hello from SQS!',
    attributes: { ApproximateReceiveCount: '1' }, eventSource: 'aws:sqs',
    awsRegion: 'us-east-1' }] },
  'EventBridge': { version: '0', id: 'fdd6cb98-d2e2-4ecf-a6f6-1d8b0f4e327a',
    'detail-type': 'Scheduled Event', source: 'aws.events',
    time: '2026-01-01T00:00:00Z', region: 'us-east-1', detail: {} },
  'DynamoDB stream': { Records: [{ eventID: '1', eventName: 'INSERT',
    eventSource: 'aws:dynamodb', awsRegion: 'us-east-1',
    dynamodb: { Keys: { Id: { N: '101' } },
      NewImage: { Id: { N: '101' }, Message: { S: 'hello' } },
      StreamViewType: 'NEW_AND_OLD_IMAGES' } }] },
}
```

- [ ] **Step 2: Write `web/src/components/event-panel.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { Play, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { EVENT_TEMPLATES } from '@/lib/templates'
import { useUpdateFunction } from '@/lib/queries'
import { useTheme } from '@/lib/theme'
import type { FunctionDef } from '@/lib/types'

export function EventPanel({ fn, eventText, onEventTextChange, onInvoke, invoking }: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
}) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const update = useUpdateFunction()

  useEffect(() => setMounted(true), [])

  const jsonError = useMemo(() => {
    try {
      JSON.parse(eventText)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }, [eventText])

  function saveEvent() {
    const name = saveName.trim()
    if (!name) return
    const savedEvents = [
      ...fn.savedEvents.filter((s) => s.name !== name),
      { name, event: JSON.parse(eventText) },
    ]
    update.mutate({ id: fn.id, patch: { savedEvents } }, {
      onSuccess: () => {
        setSaveOpen(false)
        setSaveName('')
        toast.success(`Saved event "${name}"`)
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Select value="" onValueChange={(name) =>
          onEventTextChange(JSON.stringify(EVENT_TEMPLATES[name], null, 2))}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Template…" /></SelectTrigger>
          <SelectContent>
            {Object.keys(EVENT_TEMPLATES).map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value="" onValueChange={(name) => {
          const saved = fn.savedEvents.find((s) => s.name === name)
          if (saved) onEventTextChange(JSON.stringify(saved.event, null, 2))
        }}>
          <SelectTrigger className="h-8 w-40 text-xs" disabled={fn.savedEvents.length === 0}>
            <SelectValue placeholder="Saved events…" />
          </SelectTrigger>
          <SelectContent>
            {fn.savedEvents.map((s) => (
              <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" disabled={!!jsonError}
          onClick={() => setSaveOpen(true)}>
          <Save className="size-3.5" /> Save
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {jsonError && <span className="text-xs text-destructive">invalid JSON</span>}
          <Button size="sm" onClick={onInvoke} disabled={!!jsonError || invoking}>
            <Play className="size-3.5" /> {invoking ? 'Invoking…' : 'Invoke'}
            <kbd className="ml-1 text-[10px] opacity-60">⌘⏎</kbd>
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-sm">
        {mounted && (
          <CodeMirror value={eventText} height="100%" theme={theme}
            extensions={[json()]} onChange={onEventTextChange} />
        )}
      </div>
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Save event</DialogTitle></DialogHeader>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)}
            placeholder="Event name" autoComplete="off" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={saveEvent} disabled={!saveName.trim() || update.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 3: Write `web/src/components/result-panel.tsx`**

```tsx
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { InvokeResult } from '@/lib/types'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">{children}</pre>
    </ScrollArea>
  )
}

export function ResultPanel({ result, historyTab }: {
  result: InvokeResult | null
  historyTab?: ReactNode
}) {
  return (
    <Tabs defaultValue="response" className="flex h-full flex-col gap-0">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <TabsList className="h-8">
          <TabsTrigger value="response" className="text-xs">Response</TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
          <TabsTrigger value="report" className="text-xs">Report</TabsTrigger>
          {historyTab && <TabsTrigger value="history" className="text-xs">History</TabsTrigger>}
        </TabsList>
        {result && (
          <Badge variant={result.ok ? 'secondary' : 'destructive'} className="ml-auto text-[10px]">
            {result.ok ? 'OK' : result.error?.type ?? 'ERROR'}
            {' · '}{result.report.durationMs}ms
          </Badge>
        )}
      </div>
      <TabsContent value="response" className="min-h-0 flex-1">
        <Pane>
          {!result
            ? 'Invoke to see the response.'
            : result.ok
              ? JSON.stringify(result.response, null, 2)
              : `${result.error?.type}: ${result.error?.message}\n\n${(result.error?.stackTrace ?? []).join('\n')}`}
        </Pane>
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 flex-1">
        <Pane>{result?.logs || 'No logs.'}</Pane>
      </TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1">
        <Pane>
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
        </Pane>
      </TabsContent>
      {historyTab && (
        <TabsContent value="history" className="min-h-0 flex-1">
          {historyTab}
        </TabsContent>
      )}
    </Tabs>
  )
}
```

- [ ] **Step 4: Wire the split-pane workspace into `web/src/routes/index.tsx`**

Replace the workspace block (the `FunctionHeader`/`EnvEditor`/placeholder section) with:

```tsx
          {selected ? (
            <div className="flex h-full flex-col">
              <FunctionHeader fn={selected} onDeleted={() => setSelectedId(null)} />
              <EnvEditor fn={selected} />
              <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
                <ResizablePanel defaultSize={50} minSize={25}>
                  <EventPanel
                    fn={selected}
                    eventText={drafts[selected.id] ?? '{}'}
                    onEventTextChange={(text) =>
                      setDrafts((d) => ({ ...d, [selected.id]: text }))}
                    onInvoke={() => runInvoke(selected.id)}
                    invoking={invoke.isPending}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={50} minSize={25}>
                  <ResultPanel result={result} />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          ) : (
```

Add to `App`'s body (state + invoke logic + ⌘Enter handler):

```tsx
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [result, setResult] = useState<InvokeResult | null>(null)
  const invoke = useInvoke()

  function runInvoke(functionId: string) {
    let event: unknown
    try {
      event = JSON.parse(drafts[functionId] ?? '{}')
    } catch {
      return
    }
    invoke.mutate({ functionId, event }, { onSuccess: setResult })
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selectedId) {
        e.preventDefault()
        runInvoke(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => setResult(null), [selectedId])
```

Add imports:

```tsx
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable'
import { EventPanel } from '@/components/event-panel'
import { ResultPanel } from '@/components/result-panel'
import { useFunctions, useInvoke } from '@/lib/queries'
import type { InvokeResult } from '@/lib/types'
```

- [ ] **Step 5: Verify end-to-end in the browser**

`cd web && npm run dev` — register `fixtures/node-apigw` (handler `index.handler`), pick the "API Gateway HTTP API v2" template, Invoke: Response tab shows the 200 proxy response; Logs/Report populate; ⌘Enter works; invalid JSON disables Invoke; saving and reloading a saved event works; a second rapid invoke of a slow function toasts the 409. Then `npm run typecheck && npm run build`.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: invoke workspace - split pane, CM6 event editor, templates, result tabs"
```

---

### Task 10: History tab (browse, inspect, replay, clear)

**Files:**
- Create: `web/src/components/history-list.tsx`
- Modify: `web/src/routes/index.tsx` (pass `historyTab` to `ResultPanel`)

**Interfaces:**
- Consumes: `useHistoryQuery`, `useClearHistory`, `HistoryEntry`.
- Produces: `<HistoryList fnId onLoadEvent(eventText) />` rendered inside the ResultPanel's History tab.

- [ ] **Step 1: Write `web/src/components/history-list.tsx`**

```tsx
import { useState } from 'react'
import { ArrowLeft, Download, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useClearHistory, useHistoryQuery } from '@/lib/queries'
import type { HistoryEntry } from '@/lib/types'

function age(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function HistoryList({ fnId, onLoadEvent }: {
  fnId: string
  onLoadEvent: (eventText: string) => void
}) {
  const { data: entries = [] } = useHistoryQuery(fnId)
  const clear = useClearHistory()
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null)

  if (openEntry) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setOpenEntry(null)}>
            <ArrowLeft className="size-3.5" /> Back
          </Button>
          <Badge variant={openEntry.ok ? 'secondary' : 'destructive'} className="text-[10px]">
            {openEntry.ok ? 'OK' : openEntry.error?.type ?? 'ERROR'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {age(openEntry.ts)} · {openEntry.durationMs ?? '?'}ms
            {openEntry.truncated ? ' · truncated' : ''}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto"
            onClick={() => onLoadEvent(JSON.stringify(openEntry.event, null, 2))}>
            <Download className="size-3.5" /> Load event
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">
            {`EVENT\n${JSON.stringify(openEntry.event, null, 2)}\n\n` +
              (openEntry.ok
                ? `RESPONSE\n${JSON.stringify(openEntry.response, null, 2)}`
                : `ERROR\n${openEntry.error?.type}: ${openEntry.error?.message}`) +
              `\n\nLOGS\n${openEntry.logs || '(none)'}`}
          </pre>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-xs text-muted-foreground">{entries.length} runs (max 50 kept)</span>
        <Button variant="ghost" size="sm" disabled={entries.length === 0}
          onClick={() => clear.mutate(fnId)}>
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul>
          {entries.map((e) => (
            <li key={e.id}>
              <button
                className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setOpenEntry(e)}
              >
                <Badge variant={e.ok ? 'secondary' : 'destructive'} className="text-[10px]">
                  {e.ok ? 'OK' : 'ERR'}
                </Badge>
                <span className="font-mono">{e.handler}</span>
                <span className="ml-auto text-muted-foreground">
                  {e.durationMs ?? '?'}ms · {age(e.ts)}
                </span>
              </button>
            </li>
          ))}
          {entries.length === 0 && (
            <li className="p-4 text-center text-xs text-muted-foreground">
              No runs yet. Invoke to record history.
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  )
}
```

- [ ] **Step 2: Pass the tab from `web/src/routes/index.tsx`** — change the `<ResultPanel result={result} />` line to:

```tsx
                  <ResultPanel
                    result={result}
                    historyTab={
                      <HistoryList
                        fnId={selected.id}
                        onLoadEvent={(text) =>
                          setDrafts((d) => ({ ...d, [selected.id]: text }))}
                      />
                    }
                  />
```

Add import: `import { HistoryList } from '@/components/history-list'`

- [ ] **Step 3: Verify**

`cd web && npm run dev` — invoke a few times; History tab lists runs newest-first and survives a page reload; opening a run shows event/response/logs; "Load event" fills the editor; Clear empties it. Then `npm run typecheck && npm run build`.

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: persistent history tab with inspect, replay, and clear"
```

---

### Task 11: Command palette and shortcuts

**Files:**
- Create: `web/src/components/command-palette.tsx`
- Modify: `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: shadcn `command` (cmdk), `useTheme`, function list.
- Produces: `<CommandPalette functions onSelect onAdd onInvoke />` self-manages open state on ⌘K / Ctrl+K.

- [ ] **Step 1: Write `web/src/components/command-palette.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Moon, Play, Plus, Zap } from 'lucide-react'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { useTheme } from '@/lib/theme'
import type { FunctionDef } from '@/lib/types'

export function CommandPalette({ functions, onSelect, onAdd, onInvoke }: {
  functions: FunctionDef[]
  onSelect: (id: string) => void
  onAdd: () => void
  onInvoke: () => void
}) {
  const [open, setOpen] = useState(false)
  const { toggle } = useTheme()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function run(fn: () => void) {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or function name…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onInvoke)}>
            <Play className="size-4" /> Invoke current function
          </CommandItem>
          <CommandItem onSelect={() => run(onAdd)}>
            <Plus className="size-4" /> Add function
          </CommandItem>
          <CommandItem onSelect={() => run(toggle)}>
            <Moon className="size-4" /> Toggle theme
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Functions">
          {functions.map((fn) => (
            <CommandItem key={fn.id} onSelect={() => run(() => onSelect(fn.id))}>
              <Zap className="size-4" /> {fn.name}
              <span className="ml-auto text-xs text-muted-foreground">{fn.runtime}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
```

- [ ] **Step 2: Mount it in `web/src/routes/index.tsx`** — next to `<AddFunctionDialog …/>`:

```tsx
      <CommandPalette
        functions={functions}
        onSelect={setSelectedId}
        onAdd={() => setAddOpen(true)}
        onInvoke={() => selectedId && runInvoke(selectedId)}
      />
```

Add import: `import { CommandPalette } from '@/components/command-palette'`. Also add a `⌘K` hint next to the theme toggle in the header:

```tsx
          <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
```

- [ ] **Step 3: Verify**

`cd web && npm run dev` — ⌘K opens the palette; selecting a function switches; Invoke and theme toggle actions work. `npm run typecheck && npm run build`.

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: command palette with function jump, invoke, and theme actions"
```

---

### Task 12: Design polish pass (frontend-design skill)

**Files:**
- Modify (as needed): `web/src/styles.css`, `web/src/routes/index.tsx`, components under `web/src/components/`

This task uses the **frontend-design skill** (invoke it at execution time) to move the UI from "default shadcn" toward an intentional look: check spacing rhythm, monospace usage for handler/paths/logs, empty states, focus states, dark-mode contrast of the CM6 editor, and the header/sidebar hierarchy. Constraints:

- No new dependencies, no layout restructuring (split-pane/tabs/sidebar stay).
- Keep every behavior and test intact; typecheck + build must pass.
- Small diff: token tweaks in `styles.css` (radius, muted tones, mono font stack), class-level adjustments only.

- [ ] **Step 1: Review each screen in dev mode (light + dark), list concrete nits**
- [ ] **Step 2: Apply fixes; re-verify `npm run typecheck && npm run build`**
- [ ] **Step 3: Commit**

```bash
git add web/src
git commit -m "style: design polish pass over playground UI"
```

---

### Task 13: Cutover — CLI boots the Start server; delete Express, `public/`, old test; packaging

**Files:**
- Modify: `bin/cli.js` (full rewrite)
- Delete: `server/index.js`, `public/` (entire directory), `tests/frontend.test.js`
- Modify: `package.json` (root), `README.md`, `tests/web.test.js` (one added assertion, optional)

**Interfaces:**
- Consumes: `startWebServer({ distDir, port, host })` from `server/serve-web.js` (Task 6) and the built output at `web/dist` (Task 4's build).
- Produces: `aws-playground [--port <n>] [--no-open]` behaves as before, now serving the new UI.

- [ ] **Step 1: Rewrite `bin/cli.js`**

```js
#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startWebServer } = require('../server/serve-web');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (flag('--help') || flag('-h')) {
  console.log(`Usage: aws-playground [--port <n>] [--no-open]

Starts the Lambda Playground server and opens it in your browser.

  --port <n>   Port to listen on (default 4590)
  --no-open    Do not open the browser automatically`);
  process.exit(0);
}

const DIST = path.join(__dirname, '..', 'web', 'dist');
if (!fs.existsSync(path.join(DIST, 'server', 'server.js'))) {
  console.error('aws-playground: web app not built (web/dist missing).');
  console.error('From a source checkout, run: npm run build');
  process.exit(1);
}

const port = parseInt(optValue('--port', '4590'), 10);
startWebServer({ distDir: DIST, port, host: '127.0.0.1' })
  .then((server) => {
    const url = `http://localhost:${server.address().port}`;
    console.log(`aws-playground listening at ${url}`);
    if (!flag('--no-open')) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
      spawn(opener, openArgs, { stdio: 'ignore', detached: true }).unref();
    }
  })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: aws-playground --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });
```

- [ ] **Step 2: Delete the superseded pieces**

```bash
git rm -r public server/index.js tests/frontend.test.js
npm uninstall express
```

- [ ] **Step 3: Update root `package.json`** — final state of the changed fields:

```json
{
  "main": "server/api.js",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "start": "node bin/cli.js --no-open",
    "dev": "npm --prefix web run dev",
    "build": "npm --prefix web run build",
    "test": "node --test tests/*.test.js",
    "prepublishOnly": "npm --prefix web install && npm --prefix web run build"
  },
  "files": ["bin", "server", "harnesses", "web/dist"]
}
```

- [ ] **Step 4: Update `README.md`**

- Supported-runtimes table: unchanged (user projects still need node >= 18); add a line under Install & run: "Running the playground itself requires Node >= 22.12."
- Development section becomes:

```
    npm install
    npm run build      # builds the web UI (web/.output) — required once before npm start
    npm start          # server without auto-opening the browser
    npm run dev        # web UI dev server with hot reload (also serves the API)
    npm test           # node --test; language tests auto-skip missing runtimes
```

- Replace the sentence referencing the old spec with pointers to both specs (`2026-07-18-lambda-playground-design.md`, `2026-07-18-tanstack-start-shadcn-ui-design.md`).

- [ ] **Step 5: Full verification**

```bash
npm run build
npm test                          # all pass; web.test.js not skipped
node bin/cli.js --no-open &       # manual boot check
sleep 3 && curl -s http://127.0.0.1:4590/api/health | head -c 120
curl -s http://127.0.0.1:4590/ | grep -o 'Lambda Playground'
kill %1
```

Expected: tests green; health JSON and `Lambda Playground` printed; server bound to 127.0.0.1 only (`lsof -iTCP:4590 -sTCP:LISTEN` shows 127.0.0.1).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: cut over to TanStack Start server; remove Express and legacy UI"
```

---

## Self-review notes

- Spec coverage: architecture (Tasks 1, 4, 6, 13), history (Tasks 2–3, 10), UI (Tasks 5, 7–12), testing (Tasks 1–3, 6, 13), packaging (Task 13). Design-polish task added beyond spec to satisfy the "shadcn but intentional" bar.
- The app stays runnable after every task: Express + old UI serve until Task 13; the Start app is additive until then.
- Type/name consistency spot-checks: `useHistoryQuery` (not `useHistory` — avoids clash with the DOM type), `backend.ts` exports `backend/toResponse/jsonBody` used by all six route files; `InvokePayload` matches `api.js invokeFunction(input)` field names (`functionId`, `event`, `handler`, `envVars`, `timeoutMs`, `memoryMb`).
