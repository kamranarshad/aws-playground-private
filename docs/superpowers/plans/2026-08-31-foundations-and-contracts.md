# Foundations and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the playground's persisted data crash-safe, collapse the three duplicated definitions of the trigger schema into one, put every hardcoded port behind a single source of truth, and make `npm run dev` run the same subsystems the CLI does.

**Architecture:** Four small, independent server modules — `persistence` write-atomicity, `server/ports.js`, `server/schema/`, `server/bootstrap.js` — each replacing duplicated or unsafe code that already exists. No file moves (those come in the structure plan); every change is in place so the diffs stay readable. The web app stops hardcoding the HTTP trigger port and reads it from the `/api/health` response it already polls.

**Tech Stack:** Node.js ≥22.12 (CommonJS server, zero runtime dependencies), `node:test`, React 19 + TanStack Query + TanStack Start (web), Vitest, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-31-architecture-overhaul-design.md`

## Global Constraints

- **The server stays dependency-free.** Schema validation is hand-rolled. Do not add `zod` or any other runtime dependency to the root `package.json`.
- **Node ≥ 22.12** — the engines floor. Use built-ins freely (`node:test`, `structuredClone`, `fs.cpSync`).
- **Comments explain *why*, never *what*.** This codebase's established style. A comment restating the code is a defect.
- **Conventional commits**, matching existing history: `feat(server):`, `fix(web):`, `refactor(trigger):`, `test:`, `docs:`.
- **Every commit ends with:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **No file moves in this plan.** `server/store.js` stays at `server/store.js`. The regrouping into `server/persistence/` happens in the structure plan; moving now would make every diff here unreadable.
- **Run the full server suite before each commit:** `npm run test:server`. It is serial and takes a few minutes; that is expected.

---

## Task 1: Atomic writes for the function registry

**Files:**
- Modify: `server/store.js:39-42`
- Test: `tests/store.test.js`

**Interfaces:**
- Produces: `writeFileAtomic(file, contents)` exported from `server/atomic-write.js`. Task 2 consumes it.

**Context:** `store.save()` overwrites `functions.json` in place with a bare `writeFileSync`. A crash mid-write truncates the user's whole function registry. The proof this has already happened is `store.load()`'s `.corrupt` quarantine path, which exists to recover from exactly this. Note that `tests/helpers.js:writeScenario` already uses write-then-rename for the same reason — this pattern is established in the codebase, just not applied where it matters most.

- [ ] **Step 1: Write the failing test**

Add to `tests/store.test.js`:

```js
const { writeFileAtomic } = require('../server/atomic-write');

test('writeFileAtomic replaces the target in one step', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic-'));
  const target = path.join(dir, 'data.json');
  writeFileAtomic(target, '{"v":1}');
  writeFileAtomic(target, '{"v":2}');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"v":2}');
  assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'],
    'a .tmp file was left behind after a successful write');
});

test('writeFileAtomic cleans up its temp file when the rename cannot complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic2-'));
  const target = path.join(dir, 'data.json');
  // A directory at the target makes rename(2) fail *after* the temp file has
  // been written -- the exact window that used to truncate the real file.
  fs.mkdirSync(target);

  assert.throws(() => writeFileAtomic(target, '{"v":1}'));

  assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'],
    'the temp file survived a failed rename');
  assert.ok(fs.statSync(target).isDirectory(), 'the target was clobbered');
});

test('a leftover temp file from a crash does not confuse the registry', () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-atomic3-'));
  const fn = store.create({ name: 'keeper', path: '/tmp/keeper', runtime: 'node' });
  const file = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'functions.json');
  const before = fs.readFileSync(file, 'utf8');

  fs.writeFileSync(file + '.tmp', '{"functions":[{"id":"hal');

  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(store.get(fn.id).name, 'keeper');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL — `Cannot find module '../server/atomic-write'`.

Note the second test is the load-bearing one: it proves the temp file is
cleaned up when the rename fails, which is the whole point of the helper.

- [ ] **Step 3: Create the atomic write helper**

Create `server/atomic-write.js`:

```js
const fs = require('fs');
const path = require('path');

// Write-then-rename. rename(2) is atomic within a filesystem, so a reader
// (or a crash) sees either the entire old file or the entire new one, never
// a half-written mix. The playground's registry and history are the user's
// only copy of this data -- a torn write there is unrecoverable, which is
// why store.load() carries a .corrupt quarantine path at all.
function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Leaving the temp file behind would make the next writeFileAtomic look
    // like it half-succeeded, and would slowly litter the data dir.
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { writeFileAtomic };
```

- [ ] **Step 4: Use it in `store.save`**

In `server/store.js`, replace the body of `save` (lines 39-42):

```js
function save(db) {
  writeFileAtomic(dataFile(), JSON.stringify(db, null, 2));
}
```

Add at the top of the file, after the existing requires:

```js
const { writeFileAtomic } = require('./atomic-write');
```

Delete the now-redundant `fs.mkdirSync(dataDir(), { recursive: true })` from `save` — `writeFileAtomic` does it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/store.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full server suite**

Run: `npm run test:server`
Expected: PASS. Watch `tests/api.test.js` in particular — it exercises the store through the API layer.

- [ ] **Step 7: Commit**

```bash
git add server/atomic-write.js server/store.js tests/store.test.js
git commit -m "$(cat <<'EOF'
fix(store): write the function registry atomically

A bare writeFileSync over the live functions.json truncates the user's
entire registry if the process dies mid-write. store.load()'s .corrupt
quarantine path exists precisely because this can happen; this closes the
window rather than continuing to recover from it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Atomic writes for invoke history

**Files:**
- Modify: `server/history.js:60-64`
- Test: `tests/history.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic(file, contents)` from Task 1.

**Context:** `history.writeAll` rewrites the whole JSONL file in place. It is called from `list()` (trimming to `MAX_ENTRIES`), from `append()` (compaction past `COMPACT_BYTES`), and from `appendSpans()`. An interrupted compaction currently loses the entire history file, not one entry. `append()` itself uses `appendFileSync`, which is a single small append and stays as-is — the risk being fixed is the full-file rewrite.

- [ ] **Step 1: Write the failing test**

Add to `tests/history.test.js`:

```js
test('compaction never leaves a torn history file', () => {
  const fnId = 'compact-atomic';
  for (let i = 0; i < 60; i++) {
    history.append(fnId, { handler: 'h', event: { i }, response: { i }, logs: '', report: {}, ok: true });
  }
  const file = path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'history', `${fnId}.jsonl`);

  // list() trims past MAX_ENTRIES via writeAll. Every line on disk after it
  // must still be parseable -- a torn rewrite shows up as a trailing
  // fragment that JSON.parse rejects.
  history.list(fnId);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  assert.strictEqual(lines.length, history.MAX_ENTRIES);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [],
    'a .tmp file was left behind');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/history.test.js`
Expected: FAIL on the `.tmp` assertion is *not* guaranteed here — this test passes against the old code too, because nothing interrupts the write. That is fine and expected: it is a regression guard, not a red test. Confirm it passes, then proceed; the behavioural change is proven by Task 1's test and by inspection.

- [ ] **Step 3: Use the helper in `writeAll`**

In `server/history.js`, add to the requires:

```js
const { writeFileAtomic } = require('./atomic-write');
```

Replace `writeAll`:

```js
function writeAll(functionId, oldestFirst) {
  writeFileAtomic(fileFor(functionId), oldestFirst.map(e => JSON.stringify(e)).join('\n') + '\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/history.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/history.js tests/history.test.js
git commit -m "$(cat <<'EOF'
fix(history): rewrite the history file atomically

writeAll rewrites the whole JSONL in place, so an interrupted compaction
lost every entry rather than one. Same write-then-rename as the registry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Single source of truth for ports

**Files:**
- Create: `server/ports.js`
- Modify: `server/trigger/http.js:3`, `server/trigger/s3.js:6`, `server/services/registry.js`
- Test: `tests/ports.test.js`

**Interfaces:**
- Produces: `server/ports.js` exporting `PORTS`, a frozen object:
  ```js
  { httpTrigger: 9500, s3Webhook: 9501,
    minio: 9400, minioConsole: 9401, dynamodb: 9402, redis: 9403, postgres: 9404 }
  ```
  Task 4 exposes it through `/api/health`.

**Context:** These numbers currently live as literals in three modules. `services/registry.js:27` hardcodes `9501` inside a MinIO `-e` docker argument, coupling the service registry to a trigger module's private constant — change the S3 webhook port and MinIO silently keeps posting to the old one.

- [ ] **Step 1: Write the failing test**

Create `tests/ports.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { PORTS } = require('../server/ports');
const { REGISTRY } = require('../server/services/registry');

test('every port is a distinct loopback port number', () => {
  const values = Object.values(PORTS);
  assert.ok(values.every((p) => Number.isInteger(p) && p > 1024 && p < 65536));
  assert.strictEqual(new Set(values).size, values.length, 'duplicate port assignment');
});

test('PORTS is frozen so nothing can reassign a port at runtime', () => {
  assert.throws(() => { PORTS.httpTrigger = 1; }, TypeError);
});

test('the service registry composes its ports from PORTS, not literals', () => {
  assert.strictEqual(REGISTRY.minio.endpoint, `http://127.0.0.1:${PORTS.minio}`);
  assert.strictEqual(REGISTRY.minio.consoleUrl, `http://127.0.0.1:${PORTS.minioConsole}`);
  assert.strictEqual(REGISTRY.dynamodb.endpoint, `http://127.0.0.1:${PORTS.dynamodb}`);
  assert.strictEqual(REGISTRY.redis.endpoint, `redis://127.0.0.1:${PORTS.redis}`);
  assert.strictEqual(REGISTRY.postgres.endpoint, `postgresql://127.0.0.1:${PORTS.postgres}`);
});

test("MinIO's webhook endpoint tracks the S3 trigger listener's port", () => {
  const webhook = REGISTRY.minio.runArgs.find((a) => String(a).includes('MINIO_NOTIFY_WEBHOOK_ENDPOINT'));
  assert.ok(webhook.endsWith(`:${PORTS.s3Webhook}/`),
    `expected the webhook arg to use PORTS.s3Webhook, got ${webhook}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ports.test.js`
Expected: FAIL — `Cannot find module '../server/ports'`.

- [ ] **Step 3: Create `server/ports.js`**

```js
// Every fixed loopback port the playground binds or connects to, in one
// place. These leak across module boundaries -- the MinIO container is
// configured with the S3 trigger listener's port, and the web app shows the
// HTTP trigger's port in a copyable URL -- so a literal in each consumer
// means a silent mismatch the moment one of them changes.
//
// 9400-9404 are the docker-backed local services; 9500-9501 are listeners
// this process binds itself.
const PORTS = Object.freeze({
  httpTrigger: 9500,
  s3Webhook: 9501,
  minio: 9400,
  minioConsole: 9401,
  dynamodb: 9402,
  redis: 9403,
  postgres: 9404,
});

module.exports = { PORTS };
```

- [ ] **Step 4: Consume it in the trigger listeners**

In `server/trigger/http.js`, replace line 3:

```js
const { PORTS } = require('../ports');

const PORT = PORTS.httpTrigger;
```

In `server/trigger/s3.js`, replace line 6:

```js
const { PORTS } = require('../ports');

const PORT = PORTS.s3Webhook;
```

- [ ] **Step 5: Consume it in the service registry**

In `server/services/registry.js`, add `const { PORTS } = require('../ports');` to the requires, then replace every port literal with a template referencing `PORTS`. For MinIO:

```js
    runArgs: [
      '-v', 'aws-playground-minio-data:/data',
      '-p', `127.0.0.1:${PORTS.minio}:9000`,
      '-p', `127.0.0.1:${PORTS.minioConsole}:9001`,
      '-e', 'MINIO_ROOT_USER=playground',
      '-e', 'MINIO_ROOT_PASSWORD=playground123',
      '-e', 'MINIO_NOTIFY_WEBHOOK_ENABLE_PLAYGROUND=on',
      // Points at server/trigger/s3.js's listener -- see PORTS.s3Webhook.
      '-e', `MINIO_NOTIFY_WEBHOOK_ENDPOINT_PLAYGROUND=http://host.docker.internal:${PORTS.s3Webhook}/`,
      '--add-host=host.docker.internal:host-gateway',
      'minio/minio', 'server', '/data', '--console-address', ':9001',
    ],
    ready: { type: 'http', target: `http://127.0.0.1:${PORTS.minio}/minio/health/live` },
    endpoint: `http://127.0.0.1:${PORTS.minio}`,
    consoleUrl: `http://127.0.0.1:${PORTS.minioConsole}`,
    env: { AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${PORTS.minio}` },
```

Apply the same treatment to `elasticmq` (leave 9324/9325 as-is — they are ElasticMQ's own defaults, not playground-assigned, and are not in `PORTS`), `dynamodb`, `redis`, and `postgres`, including every occurrence inside `postgres`'s `env` block (`DATABASE_URL` and `PGPORT`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/ports.test.js`
Expected: PASS, all four tests.

- [ ] **Step 7: Run the full server suite**

Run: `npm run test:server`
Expected: PASS. `tests/services.test.js` and `tests/trigger-s3.test.js` assert against these endpoints and are the real check that nothing shifted.

- [ ] **Step 8: Commit**

```bash
git add server/ports.js server/trigger/http.js server/trigger/s3.js server/services/registry.js tests/ports.test.js
git commit -m "$(cat <<'EOF'
refactor(server): put every fixed port behind one module

registry.js hardcoded the S3 trigger listener's port inside a MinIO -e
argument, so changing that listener's port would have left MinIO posting
notifications into the void. Ports now compose from server/ports.js.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Serve ports to the web, delete the duplicated constant

**Files:**
- Modify: `server/api/health.js`, `web/src/lib/types.ts`, `web/src/lib/http.ts:1`, `web/src/components/trigger-button.tsx:13,157,160`, `web/src/components/event-panel.tsx`
- Test: `tests/api.test.js`, `web/src/lib/http.test.ts`, `web/src/components/trigger-button.test.tsx`, `web/src/components/event-panel.test.tsx`

**Interfaces:**
- Consumes: `PORTS` from Task 3.
- Produces: `/api/health` response gains a `ports` key carrying `PORTS` verbatim. `buildCurlCommand(fn, eventText, httpTriggerPort)` gains a third parameter.

**Context:** `web/src/lib/http.ts:1` is `export const HTTP_TRIGGER_PORT = 9500 // must match server/trigger/http.js's PORT`. A comment is the only thing keeping the two sides in sync across a language boundary. The web already polls `/api/health` every 30s via `useHealth()`, so the port can ride along on a request that is already being made.

- [ ] **Step 1: Write the failing server test**

Add to `tests/api.test.js`:

```js
test('health reports the ports the web app needs', async () => {
  const { PORTS } = require('../server/ports');
  const { body } = await api.health();
  assert.deepStrictEqual(body.ports, PORTS);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL — `body.ports` is `undefined`.

- [ ] **Step 3: Add ports to the health response**

In `server/api/health.js`, add `const { PORTS } = require('../ports');` and return it:

```js
  return { status: 200, body: { runtimes: { python, node, java, provided }, ports: PORTS } };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/api.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing web tests**

In `web/src/lib/http.test.ts`, update every `buildCurlCommand` call to pass a port explicitly and assert it is used:

```ts
it('uses the port it is given rather than a baked-in constant', () => {
  const cmd = buildCurlCommand({ name: 'myfn' }, '{}', 9600)
  expect(cmd).toBe("curl -X GET 'http://localhost:9600/myfn/'")
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm --prefix web run test -- http`
Expected: FAIL — `buildCurlCommand` takes two parameters and ignores the third.

- [ ] **Step 7: Thread the port through the web**

In `web/src/lib/http.ts`, delete the `HTTP_TRIGGER_PORT` export and change the signature:

```ts
export function buildCurlCommand(
  fn: { name: string }, eventText: string, httpTriggerPort: number,
): string {
```

and inside, replace `HTTP_TRIGGER_PORT` with `httpTriggerPort`.

In `web/src/lib/types.ts`, add to the `Health` interface:

```ts
  ports: {
    httpTrigger: number
    s3Webhook: number
    minio: number
    minioConsole: number
    dynamodb: number
    redis: number
    postgres: number
  }
```

In `web/src/components/trigger-button.tsx`, drop the `HTTP_TRIGGER_PORT` import and read from the health query instead:

```tsx
import { useHealth } from '@/lib/queries'
...
  const { data: health } = useHealth()
  const httpPort = health?.ports.httpTrigger
```

Render the URL row only once `httpPort` is known — an empty box for one paint is better than showing a port that might be wrong:

```tsx
{httpPort !== undefined && (
  <>
    <CopyableValue aria-label="HTTP trigger URL"
      value={`http://localhost:${httpPort}/${fn.name}/...`} />
    <p className="...">
      Shares one listener on port {httpPort} across every function with an
      HTTP trigger.
    </p>
  </>
)}
```

In `web/src/components/event-panel.tsx`, read the same value and pass it to `buildCurlCommand`; update the stale comment on line 56 to stop naming a literal port.

- [ ] **Step 8: Update the component tests**

`trigger-button.test.tsx:57` and `event-panel.test.tsx:153` assert on `9500`, and neither currently stubs health at all — both call `vi.mock('@/lib/api', ...)` with only `updateFunction`, `listFunctions` and `detect`, so `api.health` is `undefined` and `useHealth()` would throw the moment the component calls it.

Two changes per file. First, add `health` to the api mock so the query has something to call:

```tsx
vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn(), detect: vi.fn(), health: vi.fn() },
}))
```

Second, seed the cache in `makeWrapper()` so the port is available on first paint and the existing synchronous assertions keep working:

```tsx
const TEST_PORTS = {
  httpTrigger: 9500, s3Webhook: 9501, minio: 9400, minioConsole: 9401,
  dynamodb: 9402, redis: 9403, postgres: 9404,
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The port is read from the health query rather than a constant now, so
  // it has to be in the cache before the first render or the URL row is
  // (correctly) not rendered at all.
  qc.setQueryData(['health'], { runtimes: {}, ports: TEST_PORTS })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}
```

`event-panel.test.tsx` has its own wrapper; apply the same two changes there. Keeping `httpTrigger: 9500` means the existing expected strings stay untouched and continue to mean something.

- [ ] **Step 9: Run the web suite**

Run: `npm --prefix web run test`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no errors. If `Health` is constructed anywhere else in tests, TypeScript will point at each site — add `ports` there too.

- [ ] **Step 11: Commit**

```bash
git add server/api/health.js web/src tests/api.test.js
git commit -m "$(cat <<'EOF'
refactor(web): read the HTTP trigger port from /api/health

The web hardcoded 9500 with a "must match server/trigger/http.js" comment
as the only thing holding the two sides in sync. It now rides along on the
health poll the app already makes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extract `server/bootstrap.js` so dev runs the real subsystems

**Files:**
- Create: `server/bootstrap.js`
- Modify: `bin/cli.js:66-113`
- Test: `tests/bootstrap.test.js`, `tests/dev.test.js`

**Interfaces:**
- Produces: `server/bootstrap.js` exporting:
  - `start(deps = {}) -> Promise<void>` — idempotent; resumes triggers and starts the S3 listener. Repeat calls are no-ops while already started.
  - `stop() -> Promise<string[]>` — stops triggers, stops auto-started containers, returns their names.
  - Later plans register the warm-environment pool's teardown inside `stop()`.

**Context:** `bin/cli.js` is the only caller of `triggerManager.resumeAll`, `s3Trigger.createListener`, and `localServices.stopAutoStarted`. `npm run dev` (vite) therefore serves a working UI and API with no triggers firing, no S3 listener bound, and no container reaping — `tests/dev.test.js` confirms only that `/api/health` and `/` respond. A contributor cannot develop a trigger feature against the dev server.

- [ ] **Step 1: Write the failing test**

Create `tests/bootstrap.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-boot-'));
const bootstrap = require('../server/bootstrap');

test('start is idempotent — a second call does not resume triggers twice', async () => {
  let resumes = 0;
  const deps = {
    triggerManager: {
      resumeAll: async () => { resumes++; },
      stopAll: () => {},
      s3RoutesFor: () => [],
      setS3ListenerError: () => {},
    },
    s3Trigger: { createListener: async () => ({ close: () => {} }) },
    localServices: { stopAutoStarted: async () => [] },
    invokeFunction: async () => ({ status: 200, body: {} }),
  };
  await bootstrap.start(deps);
  await bootstrap.start(deps);
  assert.strictEqual(resumes, 1);
  await bootstrap.stop();
});

test('a failing S3 listener is reported to the trigger manager, not thrown', async () => {
  let reported = null;
  await bootstrap.start({
    triggerManager: {
      resumeAll: async () => {},
      stopAll: () => {},
      s3RoutesFor: () => [],
      setS3ListenerError: (err) => { reported = err; },
    },
    s3Trigger: { createListener: async () => { throw new Error('port taken'); } },
    localServices: { stopAutoStarted: async () => [] },
    invokeFunction: async () => ({ status: 200, body: {} }),
  });
  assert.strictEqual(reported.message, 'port taken');
  await bootstrap.stop();
});

test('stop returns the auto-started services it stopped', async () => {
  await bootstrap.start({
    triggerManager: { resumeAll: async () => {}, stopAll: () => {}, s3RoutesFor: () => [], setS3ListenerError: () => {} },
    s3Trigger: { createListener: async () => ({ close: () => {} }) },
    localServices: { stopAutoStarted: async () => ['minio'] },
    invokeFunction: async () => ({ status: 200, body: {} }),
  });
  assert.deepStrictEqual(await bootstrap.stop(), ['minio']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/bootstrap.test.js`
Expected: FAIL — `Cannot find module '../server/bootstrap'`.

- [ ] **Step 3: Create `server/bootstrap.js`**

```js
const defaultTriggerManager = require('./trigger/manager');
const defaultS3Trigger = require('./trigger/s3');
const defaultLocalServices = require('./services');
const { invokeFunction: defaultInvokeFunction } = require('./api/invoke');

// Everything that has to happen for the playground to be *running* rather
// than merely serving HTTP: triggers resumed, the S3 webhook listener bound,
// and a teardown that leaves the machine as we found it.
//
// This lives here rather than in bin/cli.js because the vite dev server is a
// second, equally real entry point. With this wiring stranded in the CLI,
// `npm run dev` served a working UI whose triggers never fired -- so trigger
// work could not be developed against the dev server at all.
let started = false;
let listener = null;
let deps = null;

async function start(overrides = {}) {
  if (started) return;
  started = true;
  deps = {
    triggerManager: overrides.triggerManager ?? defaultTriggerManager,
    s3Trigger: overrides.s3Trigger ?? defaultS3Trigger,
    localServices: overrides.localServices ?? defaultLocalServices,
    invokeFunction: overrides.invokeFunction ?? defaultInvokeFunction,
  };

  await deps.triggerManager.resumeAll({ invokeFunction: deps.invokeFunction }).catch((err) => {
    console.warn(`aws-playground: could not resume triggers: ${err.message}`);
  });

  try {
    listener = await deps.s3Trigger.createListener({
      routesFor: deps.triggerManager.s3RoutesFor,
      invokeFunction: deps.invokeFunction,
    });
  } catch (err) {
    console.warn(`aws-playground: could not start the S3 trigger listener: ${err.message}`);
    // Without this every function with an S3 trigger keeps showing
    // 'listening' in the UI even though no event can ever reach it.
    deps.triggerManager.setS3ListenerError(err);
  }
}

async function stop() {
  if (!started) return [];
  started = false;
  deps.triggerManager.stopAll();
  try { listener?.close?.(); } catch {}
  listener = null;
  try {
    return await deps.localServices.stopAutoStarted();
  } catch (err) {
    console.warn(`aws-playground: could not stop auto-started services: ${err.message}`);
    return [];
  }
}

module.exports = { start, stop };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/bootstrap.test.js`
Expected: PASS, all three tests.

- [ ] **Step 5: Rewrite `bin/cli.js` to use it**

Replace the `installShutdownSweep` function and the `.then((server) => {...})` trigger/listener wiring with calls into `bootstrap`. The CLI keeps ownership of process signals and console output; `bootstrap` owns what actually gets started and stopped:

```js
const bootstrap = require('../server/bootstrap');

function installShutdownSweep(server) {
  let shuttingDown = false;
  const bye = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    const stopped = await bootstrap.stop();
    if (stopped.length) {
      console.log(`aws-playground: stopped auto-started ${stopped.join(', ')}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
```

and in the `.then`:

```js
  .then((server) => {
    installShutdownSweep(server);
    bootstrap.start();
    const url = `http://localhost:${server.address().port}`;
    ...
```

Delete the now-unused `triggerManager`, `s3Trigger`, `localServices` and `invokeFunction` requires from `bin/cli.js`.

- [ ] **Step 6: Start bootstrap from the dev path**

In `web/src/lib/backend.ts`, after `loadBackend()`, kick off the bootstrap in dev so the vite server runs the same subsystems the CLI does:

```ts
// The CLI calls bootstrap.start() itself. Under `vite dev` there is no CLI,
// so without this the dev server serves a UI whose triggers never fire.
if (import.meta.env.DEV) {
  cached.startBootstrap?.()
}
```

Export it from `server/api/index.js` so the backend proxy can reach it:

```js
const bootstrap = require('../bootstrap');
...
module.exports = { ..., startBootstrap: () => bootstrap.start() };
```

- [ ] **Step 7: Extend the dev-parity test**

In `tests/dev.test.js`, after the existing `/api/health` assertion, prove the trigger subsystem is actually live under vite:

```js
      const triggers = await fetch(`http://localhost:${port}/api/triggers`);
      assert.strictEqual(triggers.status, 200,
        `expected 200 from /api/triggers, got ${triggers.status}`);
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/bootstrap.test.js tests/cli.test.js tests/dev.test.js`
Expected: PASS. `tests/cli.test.js` spawns the real CLI and is the check that the rewrite in Step 5 did not break startup.

- [ ] **Step 9: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/bootstrap.js server/api/index.js bin/cli.js web/src/lib/backend.ts tests/bootstrap.test.js tests/dev.test.js
git commit -m "$(cat <<'EOF'
refactor(server): extract bootstrap so dev runs the real subsystems

Trigger resumption, the S3 listener and the container sweep lived only in
bin/cli.js, so `npm run dev` served a UI whose triggers never fired. Both
entry points now call the same idempotent bootstrap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The schema module

**Files:**
- Create: `server/schema/function.js`, `server/schema/trigger.js`, `server/schema/index.js`
- Test: `tests/schema.test.js`

**Interfaces:**
- Produces:
  - `DEFAULTS` — the object `store.create` currently inlines.
  - `ALLOWED_KEYS` — the array `store.update` currently inlines.
  - `RUNTIMES` — `['python', 'node', 'java', 'provided']`.
  - `validateTrigger(trigger) -> string | null` — an error message, or `null` when valid. Mutates `trigger.events` to dedupe for S3 (existing behaviour, preserved deliberately — see below).
  - `coerceTrigger(raw) -> trigger | null` — lenient: returns a normalised trigger or `null`, never an error. This is `playground.json`'s semantics.
  - `validateFields(fields, { currentId, list, get }) -> string | null`.
- Consumed by Task 7 (`api/functions.js`) and Task 8 (`projectconfig.js`).

**Context:** The trigger shape is specified three times today — `triggerError()` in `server/api/functions.js:14`, `parseTrigger()` in `server/projectconfig.js:5`, and `FunctionTrigger` in `web/src/lib/types.ts:12`. They have already drifted and been re-synced: the S3 dedup comment appears verbatim in both server files because the same bug was fixed twice.

**Critical:** the two server call sites need genuinely different behaviour and this module must preserve both, not unify them into one. `validateTrigger` reports *why* a UI submission was rejected. `coerceTrigger` silently drops invalid `playground.json` values so a typo in a project file cannot brick the function. Do not collapse these.

- [ ] **Step 1: Write the failing test**

Create `tests/schema.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const schema = require('../server/schema');

test('validateTrigger accepts each supported trigger type', () => {
  assert.strictEqual(schema.validateTrigger({ type: 'http', enabled: true }), null);
  assert.strictEqual(schema.validateTrigger({ type: 'sqs', queueName: 'q', enabled: true }), null);
  assert.strictEqual(schema.validateTrigger({ type: 'dynamodb', tableName: 't', enabled: false }), null);
  assert.strictEqual(schema.validateTrigger(
    { type: 's3', bucket: 'b', events: ['ObjectCreated'], enabled: true }), null);
  assert.strictEqual(schema.validateTrigger(null), null);
});

test('validateTrigger explains each rejection', () => {
  assert.match(schema.validateTrigger({ type: 'kinesis', enabled: true }), /unsupported trigger type/);
  assert.match(schema.validateTrigger({ type: 'sqs', queueName: '  ', enabled: true }), /queueName is required/);
  assert.match(schema.validateTrigger({ type: 'dynamodb', tableName: '', enabled: true }), /tableName is required/);
  assert.match(schema.validateTrigger({ type: 's3', events: ['ObjectCreated'], enabled: true }), /bucket is required/);
  assert.match(schema.validateTrigger({ type: 's3', bucket: 'b', events: [], enabled: true }), /non-empty array/);
  assert.match(schema.validateTrigger({ type: 'http' }), /enabled must be a boolean/);
});

test('validateTrigger dedupes s3 events in place', () => {
  const trigger = { type: 's3', bucket: 'b', events: ['ObjectCreated', 'ObjectCreated'], enabled: true };
  assert.strictEqual(schema.validateTrigger(trigger), null);
  assert.deepStrictEqual(trigger.events, ['ObjectCreated']);
});

test('coerceTrigger drops invalid values instead of explaining them', () => {
  assert.strictEqual(schema.coerceTrigger({ type: 'kinesis' }), null);
  assert.strictEqual(schema.coerceTrigger({ type: 'sqs', queueName: '   ' }), null);
  assert.strictEqual(schema.coerceTrigger(undefined), null);
  assert.deepStrictEqual(schema.coerceTrigger({ type: 'sqs', queueName: '  q  ' }),
    { type: 'sqs', queueName: 'q', enabled: true });
  assert.deepStrictEqual(
    schema.coerceTrigger({ type: 's3', bucket: 'b', events: ['ObjectCreated', 'bogus', 'ObjectCreated'] }),
    { type: 's3', bucket: 'b', events: ['ObjectCreated'], enabled: true });
});

test('a playground.json trigger is always enabled — declaring it is opting in', () => {
  assert.strictEqual(schema.coerceTrigger({ type: 'http', enabled: false }).enabled, true);
});

test('validateFields rejects the values that would break an invoke', () => {
  const list = () => [];
  const get = () => null;
  assert.match(schema.validateFields({ runtime: 'ruby' }, { list, get }), /unsupported runtime/);
  assert.match(schema.validateFields({ timeoutMs: 'soon' }, { list, get }), /timeoutMs must be a positive number/);
  assert.match(schema.validateFields({ memoryMb: 0 }, { list, get }), /memoryMb must be a positive number/);
  assert.match(schema.validateFields({ autoTrace: 'yes' }, { list, get }), /autoTrace must be a boolean/);
  assert.strictEqual(schema.validateFields({ runtime: 'node', timeoutMs: 1, memoryMb: 1 }, { list, get }), null);
});

test('validateFields rejects a duplicate name but not the function itself', () => {
  const list = () => [{ id: 'a', name: 'taken' }];
  const get = () => null;
  assert.match(schema.validateFields({ name: 'taken' }, { list, get }), /already exists/);
  assert.strictEqual(schema.validateFields({ name: 'taken' }, { currentId: 'a', list, get }), null);
});

test('validateFields guards http routing on a rename with no trigger in the patch', () => {
  const list = () => [{ id: 'a', name: 'a' }];
  const get = () => ({ id: 'a', name: 'a', trigger: { type: 'http', enabled: true } });
  assert.match(schema.validateFields({ name: 'has/slash' }, { currentId: 'a', list, get }),
    /without '\/' characters/);
});

test('DEFAULTS covers every key store.create sets', () => {
  for (const k of ['handler', 'timeoutMs', 'memoryMb', 'jarPath', 'env', 'envFile',
    'buildCommand', 'localServices', 'savedEvents', 'trigger', 'autoTrace']) {
    assert.ok(k in schema.DEFAULTS, `DEFAULTS is missing ${k}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/schema.test.js`
Expected: FAIL — `Cannot find module '../server/schema'`.

- [ ] **Step 3: Write `server/schema/trigger.js`**

Move the logic from `api/functions.js:triggerError` and `projectconfig.js:parseTrigger` here verbatim, then express both through shared per-type rules:

```js
const TRIGGER_TYPES = ['sqs', 'http', 'dynamodb', 's3'];
const S3_EVENTS = ['ObjectCreated', 'ObjectRemoved'];

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Strict: returns a message explaining the rejection, for a UI submission
// the user can correct. null means valid.
function validateTrigger(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (!TRIGGER_TYPES.includes(trigger.type)) {
    return `unsupported trigger type '${trigger.type}'`;
  }
  if (trigger.type === 'sqs' && !nonEmptyString(trigger.queueName)) {
    return 'trigger.queueName is required';
  }
  if (trigger.type === 'dynamodb' && !nonEmptyString(trigger.tableName)) {
    return 'trigger.tableName is required';
  }
  if (trigger.type === 's3') {
    if (!nonEmptyString(trigger.bucket)) return 'trigger.bucket is required';
    if (!Array.isArray(trigger.events) || trigger.events.length === 0
      || !trigger.events.every((e) => S3_EVENTS.includes(e))) {
      return "trigger.events must be a non-empty array of 'ObjectCreated'/'ObjectRemoved'";
    }
    // Normalized in place (this object is the one that goes on to the store):
    // a repeated event means nothing extra, and a stored duplicate would make
    // a real events-list change look unchanged to the trigger manager's
    // route comparison, silently skipping the reconfigure.
    trigger.events = [...new Set(trigger.events)];
    if (trigger.prefix !== undefined && typeof trigger.prefix !== 'string') return 'trigger.prefix must be a string';
    if (trigger.suffix !== undefined && typeof trigger.suffix !== 'string') return 'trigger.suffix must be a string';
  }
  if (typeof trigger.enabled !== 'boolean') return 'trigger.enabled must be a boolean';
  return null;
}

// Lenient: returns a normalized trigger or null, never a message. A
// playground.json is a file the user edits by hand outside the UI, so an
// invalid value there falls back to the function's manual configuration
// rather than bricking it with an error nobody sees. Declaring a trigger in
// the file IS opting in, so `enabled` is always true regardless of the file.
function coerceTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'http') return { type: 'http', enabled: true };
  if (raw.type === 'sqs') {
    return nonEmptyString(raw.queueName)
      ? { type: 'sqs', queueName: raw.queueName.trim(), enabled: true } : null;
  }
  if (raw.type === 'dynamodb') {
    return nonEmptyString(raw.tableName)
      ? { type: 'dynamodb', tableName: raw.tableName.trim(), enabled: true } : null;
  }
  if (raw.type === 's3') {
    if (!nonEmptyString(raw.bucket)) return null;
    const events = Array.isArray(raw.events)
      ? [...new Set(raw.events.filter((e) => S3_EVENTS.includes(e)))] : [];
    if (events.length === 0) return null;
    const trigger = { type: 's3', bucket: raw.bucket.trim(), events, enabled: true };
    if (nonEmptyString(raw.prefix)) trigger.prefix = raw.prefix.trim();
    if (nonEmptyString(raw.suffix)) trigger.suffix = raw.suffix.trim();
    return trigger;
  }
  return null;
}

module.exports = { TRIGGER_TYPES, S3_EVENTS, validateTrigger, coerceTrigger };
```

- [ ] **Step 4: Write `server/schema/function.js`**

Move `DEFAULTS`/`ALLOWED_KEYS` out of `store.js` and `fieldError` out of `api/functions.js`. `validateFields` takes `list`/`get` as injected accessors so the schema module does not depend on the store — that keeps the dependency arrow pointing one way and makes the module testable without a data directory:

```js
const fs = require('fs');
const { validateTrigger } = require('./trigger');

const RUNTIMES = ['python', 'node', 'java', 'provided'];

const ALLOWED_KEYS = ['name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'envFile', 'buildCommand', 'localServices',
  'savedEvents', 'trigger', 'autoTrace'];

const DEFAULTS = {
  handler: '', timeoutMs: 30000, memoryMb: 128, jarPath: null, env: {},
  envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
  trigger: null, autoTrace: false,
};

// Shared between create (fields always present) and update (fields present
// only when patched) so a PATCH can't put the store into a state POST would
// have rejected -- e.g. a non-numeric timeoutMs, which downstream clamps
// setTimeout to ~1ms and SIGKILLs every future invoke almost instantly.
// `currentId` is the function's own id on update (excluded from the name
// collision checks below); null on create, where there's no "self" yet.
function validateFields(fields, { currentId = null, list, get }) {
  if ('runtime' in fields && !RUNTIMES.includes(fields.runtime)) {
    return `unsupported runtime '${fields.runtime}'`;
  }
  if ('path' in fields
    && (!fs.existsSync(fields.path) || !fs.statSync(fields.path).isDirectory())) {
    return `path is not a directory: ${fields.path}`;
  }
  if ('timeoutMs' in fields && !(Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0)) {
    return 'timeoutMs must be a positive number';
  }
  if ('memoryMb' in fields && !(Number.isFinite(fields.memoryMb) && fields.memoryMb > 0)) {
    return 'memoryMb must be a positive number';
  }
  if ('autoTrace' in fields && typeof fields.autoTrace !== 'boolean') {
    return 'autoTrace must be a boolean';
  }
  // Required for the HTTP trigger's routing-by-name to be unambiguous, but
  // enforced unconditionally (not just when a trigger is involved) -- the
  // simpler, single rule to reason about.
  if ('name' in fields && typeof fields.name === 'string'
    && list().some((f) => f.name === fields.name && f.id !== currentId)) {
    return `a function named '${fields.name}' already exists`;
  }
  if ('trigger' in fields) {
    const triggerErr = validateTrigger(fields.trigger);
    if (triggerErr) return triggerErr;
  }
  // The effective trigger is whatever this patch leaves in place: the new
  // trigger if it's being changed here, otherwise the function's current
  // stored trigger. A name-only rename (no `trigger` in this patch) must
  // still be checked against an already-enabled http trigger, since it can
  // just as easily break routing.
  const effectiveTrigger = 'trigger' in fields ? fields.trigger : (currentId ? get(currentId)?.trigger : null);
  if (effectiveTrigger?.type === 'http' && effectiveTrigger.enabled) {
    const name = 'name' in fields ? fields.name : (currentId ? get(currentId)?.name : undefined);
    if (typeof name === 'string' && name.includes('/')) {
      return "an HTTP trigger requires a name without '/' characters";
    }
    if (typeof name === 'string' && list().some((f) => f.name === name && f.id !== currentId)) {
      return `a function named '${name}' already exists — rename it before enabling an HTTP trigger`;
    }
  }
  return null;
}

module.exports = { RUNTIMES, ALLOWED_KEYS, DEFAULTS, validateFields };
```

Create `server/schema/index.js`:

```js
const trigger = require('./trigger');
const fn = require('./function');

module.exports = { ...trigger, ...fn };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/schema.test.js`
Expected: PASS, all nine tests.

- [ ] **Step 6: Commit**

```bash
git add server/schema tests/schema.test.js
git commit -m "$(cat <<'EOF'
feat(schema): add one module owning the function and trigger shapes

The trigger shape was specified three times and had already drifted --
the S3 dedup comment is copy-pasted across two files because the same bug
was fixed twice. Strict and lenient validation stay separate on purpose:
the API explains rejections, playground.json silently ignores them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Point the store and the API at the schema

**Files:**
- Modify: `server/store.js:6-8,44-63,65-71`, `server/api/functions.js:1-100`
- Test: `tests/api.test.js`, `tests/store.test.js` (should need no changes — that is the point)

**Interfaces:**
- Consumes: `DEFAULTS`, `ALLOWED_KEYS`, `RUNTIMES`, `validateFields`, `validateTrigger` from Task 6.
- Produces: `server/api/functions.js` keeps exporting `RUNTIMES` (re-exported from the schema) so `server/api/index.js` is unchanged.

- [ ] **Step 1: Delete the duplicated definitions from `store.js`**

Replace the inline `ALLOWED_KEYS` with an import, and build `create` from `DEFAULTS`:

```js
const { ALLOWED_KEYS, DEFAULTS } = require('./schema');
...
function create(input) {
  const db = load();
  const fn = { id: crypto.randomUUID(), ...DEFAULTS };
  for (const k of ALLOWED_KEYS) if (input[k] !== undefined) fn[k] = input[k];
  db.functions.push(fn);
  save(db);
  return fn;
}
```

Note this is a behaviour-preserving rewrite of the `??` chain: `DEFAULTS` supplies the fallback and any explicitly provided key overrides it. `name`, `path` and `runtime` have no default and are required by the API layer before `create` is reached.

- [ ] **Step 2: Run the store tests**

Run: `node --test tests/store.test.js`
Expected: PASS with no test changes. If `create applies defaults` fails, the `DEFAULTS` object does not match the old `??` chain — fix `DEFAULTS`, not the test.

- [ ] **Step 3: Delete the duplicated definitions from `api/functions.js`**

Remove `RUNTIMES`, `triggerError` and `fieldError` entirely. Replace their uses:

```js
const schema = require('../schema');
const RUNTIMES = schema.RUNTIMES;

function fieldError(fields, currentId = null) {
  return schema.validateFields(fields, { currentId, list: store.list, get: store.get });
}
```

Keep the local `fieldError` wrapper — it binds the store accessors once and leaves `createFunction`/`updateFunction` untouched.

- [ ] **Step 4: Run the API tests**

Run: `node --test tests/api.test.js`
Expected: PASS with no test changes. `tests/api.test.js` is 783 lines and covers this validation heavily; it is the real proof the extraction preserved behaviour.

- [ ] **Step 5: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/store.js server/api/functions.js
git commit -m "$(cat <<'EOF'
refactor(server): validate through the schema module

store.js and api/functions.js each carried their own copy of the field
list, the defaults and the trigger rules. Both now defer to server/schema.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Point `projectconfig` at the schema

**Files:**
- Modify: `server/projectconfig.js:1-33`
- Test: `tests/projectconfig.test.js` (should need no changes)

**Interfaces:**
- Consumes: `coerceTrigger` from Task 6.

- [ ] **Step 1: Replace `parseTrigger` with the schema's lenient coercion**

`server/projectconfig.js` becomes:

```js
const fs = require('fs');
const path = require('path');
const services = require('./services');
const { coerceTrigger } = require('./schema');

// Per-project playground.json. Re-read fresh on every use, like .env.
// A null `services`/`trigger` means "no file governance" for that key
// (missing file, invalid JSON, or an invalid/absent value) — callers then
// fall back to the function's manual configuration.
function read(dir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'playground.json'), 'utf8'));
  } catch {
    return { services: null, trigger: null };
  }
  const known = new Set(services.names());
  return {
    services: Array.isArray(parsed?.services) ? parsed.services.filter((s) => known.has(s)) : null,
    trigger: coerceTrigger(parsed?.trigger),
  };
}

module.exports = { read };
```

- [ ] **Step 2: Run the projectconfig tests**

Run: `node --test tests/projectconfig.test.js`
Expected: PASS with no test changes.

- [ ] **Step 3: Run the trigger tests**

Run: `node --test tests/effective-trigger.test.js tests/trigger-manager.test.js tests/trigger-s3.test.js`
Expected: PASS. `effectiveTrigger` reads through `projectconfig`, so these are the integration check.

- [ ] **Step 4: Run the full server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/projectconfig.js
git commit -m "$(cat <<'EOF'
refactor(projectconfig): coerce triggers through the schema module

Third and last copy of the trigger shape on the server side.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Typecheck the server

**Files:**
- Create: `server/tsconfig.json`, `server/types.d.ts`
- Modify: `package.json` (add a `typecheck:server` script), `.github/workflows/ci.yml`
- Test: the typecheck run itself

**Interfaces:**
- Produces: `server/types.d.ts` declaring `Runtime`, `SavedEvent`, `FunctionTrigger`, `FunctionDef`, `Ports`, `ApiResult<T>`. The structure plan re-exports these to the web app through the workspace package, deleting the duplicates in `web/src/lib/types.ts`.

**Context:** CI typechecks `web` only. Nothing checks the server, which is exactly where Task 6's extraction could silently drift from the web's hand-mirrored types.

- [ ] **Step 1: Write `server/types.d.ts`**

Mirror `web/src/lib/types.ts:1-39` exactly — this file becomes the source those types are later derived from:

```ts
export type Runtime = 'python' | 'node' | 'java' | 'provided'

export interface SavedEvent {
  name: string
  event: unknown
  assertionScript?: string
}

export type FunctionTrigger =
  | { type: 'sqs'; queueName: string; enabled: boolean }
  | { type: 'http'; enabled: boolean }
  | { type: 'dynamodb'; tableName: string; enabled: boolean }
  | {
      type: 's3'
      bucket: string
      events: ('ObjectCreated' | 'ObjectRemoved')[]
      prefix?: string
      suffix?: string
      enabled: boolean
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
  envFile: string
  buildCommand: string
  localServices: string[]
  trigger: FunctionTrigger | null
  savedEvents: SavedEvent[]
  autoTrace: boolean
}

export interface Ports {
  httpTrigger: number
  s3Webhook: number
  minio: number
  minioConsole: number
  dynamodb: number
  redis: number
  postgres: number
}

/** Every server/api/* function returns this shape; the route handlers in
 *  web/src/routes/api.*.ts turn it into a Response. */
export interface ApiResult<T = unknown> {
  status: number
  body?: T
}
```

- [ ] **Step 2: Add `server/tsconfig.json`**

`checkJs` over plain CommonJS finds real bugs (typos in property names, wrong arity) without requiring a single annotation. Start permissive so the first run is actionable rather than a wall of noise:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "module": "CommonJS",
    "moduleResolution": "Node",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": false,
    "skipLibCheck": true
  },
  "include": ["**/*.js", "types.d.ts"]
}
```

- [ ] **Step 3: Add the script and run it**

In the root `package.json` scripts:

```json
    "typecheck:server": "tsc -p server/tsconfig.json"
```

Run: `npx tsc -p server/tsconfig.json`

Expected: some errors on the first run. Fix each one by adding a JSDoc type or correcting real sloppiness — **do not** silence them by loosening the config further. If a genuine dynamic pattern cannot be expressed (the `backend` Proxy is the likely candidate, though that lives in web), annotate it with a targeted `// @ts-expect-error` plus a comment saying why.

- [ ] **Step 4: Wire it into CI**

In `.github/workflows/ci.yml`, after the existing "Typecheck web" step:

```yaml
      - name: Typecheck server
        run: npm run typecheck:server
```

`typescript` is already available at the root through `web`'s dependency tree; if `npx tsc` cannot resolve it from the root, add `typescript` to the root `devDependencies` at the same version `web` pins.

- [ ] **Step 5: Run the full check locally**

Run: `npm run typecheck:server && npm run test:server && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/tsconfig.json server/types.d.ts package.json package-lock.json .github/workflows/ci.yml server
git commit -m "$(cat <<'EOF'
build: typecheck the server with checkJs

CI checked types for web only, leaving the server -- where the schema
extraction is most likely to drift from the web's mirrored types --
entirely unchecked.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

- [ ] `npm run test:server` passes
- [ ] `npm run test:web` passes
- [ ] `npm --prefix web run typecheck` passes
- [ ] `npm run typecheck:server` passes
- [ ] `npm run lint` passes
- [ ] `grep -rn "9500" web/src --include='*.ts' --include='*.tsx' | grep -v test` returns nothing
- [ ] `grep -c "unsupported trigger type" server -r` returns exactly 1
