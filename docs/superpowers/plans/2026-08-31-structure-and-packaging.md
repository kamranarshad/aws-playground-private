# Structure and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `server/` a module layout that states what each group is for, split the two files that have outgrown themselves (`trigger/s3.js`, `api/invoke.js`), make `server/` a real package so the web app stops reaching across the repo with `createRequire`, and stop shipping build artifacts in git.

**Architecture:** Four concerns currently sharing `server/`'s root become `server/persistence/`, `server/runtime/` and `server/trace/` (with `schema/`, `api/`, `services/`, `trigger/` already grouped). Moves happen before the workspace conversion so `web/src/lib/backend.ts`'s module resolution is rewritten exactly once. Packaging changes land last and are verified against a real `npm pack` and a clean clone, not just a passing unit suite.

**Tech Stack:** Node.js ≥22.12 (CommonJS server), npm workspaces, `node:test`, Vite/TanStack Start (web), oxlint, TypeScript `checkJs`.

**Spec:** `docs/superpowers/specs/2026-08-31-architecture-overhaul-design.md`

**Predecessor:** `docs/superpowers/plans/2026-08-31-foundations-and-contracts.md` (Phases A+B, complete at `d5bd8a8`)

## Global Constraints

- **The server stays dependency-free.** No new runtime dependencies at the root.
- **Node ≥ 22.12.** `typescript` is a root devDependency as of `d5bd8a8`.
- **Comments explain *why*, never *what*.**
- **Conventional commits**, each ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Use `git mv`, never delete-and-recreate.** History for these files is the main record of why the code looks the way it does; a move that breaks `git log --follow` throws that away.
- **`tests/trigger-docker.test.js` is broken on this machine before this work starts** — two failures plus a file-level timeout, proven pre-existing by reverting to baseline. Exclude it from the gate:
  ```bash
  ls tests/*.test.js | grep -v trigger-docker | xargs node --test --test-concurrency=1 --test-timeout=120000
  ```
- **The gate for every task:** the command above (382 passing as of `d5bd8a8`), plus `npm run typecheck:server`, plus `npm --prefix web run test` and `npm --prefix web run typecheck` for any task touching `web/`.
- **A pure move must not change behaviour.** If a test needs editing beyond its `require` path, stop — something moved that should not have.

---

## Task 1: `server/persistence/`

**Files:**
- Move: `server/store.js`, `server/history.js`, `server/projectconfig.js`, `server/atomic-write.js` → `server/persistence/`
- Modify: every requirer (below)
- Test: existing suites, `require` paths updated

**Interfaces:**
- Produces: `require('../persistence/store')` from `server/api/*`, `require('./persistence/store')` from `server/*.js`. Later tasks consume these paths.

**Context:** These four files are the only ones that own on-disk state. Grouping them makes that boundary explicit and gives the warm-environment pool (Phase D) an obvious place *not* to be.

- [ ] **Step 1: Move the files**

```bash
mkdir -p server/persistence
git mv server/store.js server/history.js server/projectconfig.js server/atomic-write.js server/persistence/
```

- [ ] **Step 2: Fix requires inside the moved files**

`persistence/history.js` and `persistence/store.js` require `./atomic-write` — unchanged, they moved together. `persistence/projectconfig.js` requires `./services` — now one level up:

```js
const services = require('../services');
```

`persistence/history.js` requires `./store` — unchanged, same directory.

- [ ] **Step 3: Fix requires in the rest of `server/`**

In `server/api/functions.js`, `server/api/invoke.js`, `server/api/history.js`, `server/trigger/manager.js`, `server/trigger/sqs.js`, `server/trigger/dynamodb.js`, `server/trigger/effective.js`, `server/bootstrap.js`:

```
'../store'         -> '../persistence/store'
'../history'       -> '../persistence/history'
'../projectconfig' -> '../persistence/projectconfig'
```

Mechanically:

```bash
grep -rl "require('\.\./\(store\|history\|projectconfig\)')" server/ \
  | xargs sed -i '' -E "s|require\('\.\./(store\|history\|projectconfig)'\)|require('../persistence/\1')|g"
```

`server/persistence/history.js` requires `{ dataDir }` from `./store` — verify that still resolves after the move.

- [ ] **Step 4: Fix test requires**

```bash
sed -i '' -E "s|require\('\.\./server/(store\|history\|projectconfig\|atomic-write)'\)|require('../server/persistence/\1')|g" tests/*.js
```

- [ ] **Step 5: Run the gate**

```bash
ls tests/*.test.js | grep -v trigger-docker | xargs node --test --test-concurrency=1 --test-timeout=120000
npm run typecheck:server
```
Expected: 382 pass, 0 type errors. Any test needing more than a `require`-path edit means something is wrong — stop.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(server): group the on-disk state modules under persistence/

store, history, projectconfig and atomic-write are the only modules that
own files on disk. Grouping them names that boundary.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `server/runtime/`

**Files:**
- Move: `server/invoker.js`, `server/build.js`, `server/detect.js`, `server/envfile.js`, `server/node-version.js` → `server/runtime/`

**Context:** Everything about *launching a handler*: finding it, building it, resolving its env, and running it. Phase D's process pool joins this directory.

- [ ] **Step 1: Move the files**

```bash
mkdir -p server/runtime
git mv server/invoker.js server/build.js server/detect.js server/envfile.js server/node-version.js server/runtime/
```

- [ ] **Step 2: Fix requires inside the moved files**

`runtime/invoker.js` requires `./detect` (unchanged — moved together), `./auto-trace-detect`, `./trace-receiver`, `./trace-collector`. Those three move in Task 3; leave them as `../auto-trace-detect` etc. for now and Task 3 corrects them. To avoid a broken intermediate commit, do Task 2 and Task 3 as one commit if you prefer — but the moves themselves are independent.

For this task, update `runtime/invoker.js`:

```js
const { hasOwnTracingSetup } = require('../auto-trace-detect');
const traceReceiver = require('../trace-receiver');
const traceCollector = require('../trace-collector');
```

and its harness path, which walks up one more level now:

```js
const HARNESS_DIR = path.join(__dirname, '..', '..', 'harnesses');
```

**This is the one substantive edit in the move** — miss it and every invoke fails to find its harness. `tests/invoker.test.js` and every `harness-*.test.js` catch it.

- [ ] **Step 3: Fix requires elsewhere**

```
'../invoker'      -> '../runtime/invoker'      (server/api/invoke.js)
'../build'        -> '../runtime/build'        (server/api/invoke.js)
'../detect'       -> '../runtime/detect'       (server/api/functions.js, server/api/invoke.js)
'./node-version'  -> './runtime/node-version'  (scripts/prepare.js -> '../server/runtime/node-version')
```

`bin/cli.js` requires `../server/node-version` → `../server/runtime/node-version`.

- [ ] **Step 4: Fix test requires**

```bash
sed -i '' -E "s|require\('\.\./server/(invoker\|build\|detect\|envfile\|node-version)'\)|require('../server/runtime/\1')|g" tests/*.js
```

- [ ] **Step 5: Run the gate, then commit**

```bash
ls tests/*.test.js | grep -v trigger-docker | xargs node --test --test-concurrency=1 --test-timeout=120000
npm run typecheck:server
git add -A
git commit -m "$(cat <<'EOF'
refactor(server): group the handler-launching modules under runtime/

invoker, build, detect, envfile and node-version are all about getting a
handler to run. HARNESS_DIR gains a level to match.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `server/trace/`

**Files:**
- Move + rename: `server/trace-receiver.js` → `server/trace/receiver.js`, `server/trace-collector.js` → `server/trace/collector.js`, `server/otlp-decode.js` → `server/trace/otlp-decode.js`, `server/auto-trace-detect.js` → `server/trace/auto-trace-detect.js`

**Context:** The `trace-` prefix exists only because these sat in a flat directory. Inside `trace/` it is noise.

- [ ] **Step 1: Move and rename**

```bash
mkdir -p server/trace
git mv server/trace-receiver.js server/trace/receiver.js
git mv server/trace-collector.js server/trace/collector.js
git mv server/otlp-decode.js server/trace/otlp-decode.js
git mv server/auto-trace-detect.js server/trace/auto-trace-detect.js
```

- [ ] **Step 2: Fix requires**

Inside `trace/receiver.js`: `require('./otlp-decode')` and `require('./trace-collector')` → `require('./collector')`.

In `server/runtime/invoker.js`:

```js
const { hasOwnTracingSetup } = require('../trace/auto-trace-detect');
const traceReceiver = require('../trace/receiver');
const traceCollector = require('../trace/collector');
```

In `server/api/history.js`, whichever of these it requires, repoint to `../trace/*`.

- [ ] **Step 3: Fix test requires**

```bash
sed -i '' -e "s|require('../server/trace-receiver')|require('../server/trace/receiver')|g" \
  -e "s|require('../server/trace-collector')|require('../server/trace/collector')|g" \
  -e "s|require('../server/otlp-decode')|require('../server/trace/otlp-decode')|g" \
  -e "s|require('../server/auto-trace-detect')|require('../server/trace/auto-trace-detect')|g" tests/*.js
```

- [ ] **Step 4: Run the gate, then commit**

```bash
ls tests/*.test.js | grep -v trigger-docker | xargs node --test --test-concurrency=1 --test-timeout=120000
npm run typecheck:server
git add -A
git commit -m "$(cat <<'EOF'
refactor(server): group the tracing modules under trace/

The trace- filename prefix only existed to disambiguate inside a flat
directory; inside trace/ it is noise.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Split `server/trigger/s3.js`

**Files:**
- Create: `server/trigger/s3/events.js`, `server/trigger/s3/listener.js`, `server/trigger/s3/bucket-config.js`, `server/trigger/s3/index.js`
- Delete: `server/trigger/s3.js` (via `git mv` to `s3/index.js` first, so history follows)
- Test: `tests/trigger-s3.test.js` unchanged except its require path

**Interfaces:**
- Produces: `server/trigger/s3/index.js` exports exactly what `s3.js` exported today — `type`, `sync`, `stop`, `status`, `statusAll`, `createListener`, `s3RoutesFor`, `setS3ListenerError`, `drainBucketConfigQueue`, plus whatever `tests/trigger-s3.test.js` reaches for. **Verify against the current `module.exports` before splitting; the export surface must not change.**

**Context:** 336 lines doing four jobs — the MinIO webhook listener, event normalisation and route matching, bucket-notification configuration, and the driver state machine. It is the largest file in `server/` and the hardest to hold in your head.

- [ ] **Step 1: Record the current export surface**

```bash
sed -n '/^module.exports/,$p' server/trigger/s3.js
grep -oE "s3Trigger\.[a-zA-Z]+|s3\.[a-zA-Z]+" tests/trigger-s3.test.js tests/trigger-docker.test.js | sort -u
```

Write the list down. It is the contract for Step 5.

- [ ] **Step 2: Move the file into the directory, keeping history**

```bash
mkdir -p server/trigger/s3
git mv server/trigger/s3.js server/trigger/s3/index.js
sed -i '' -e "s|require('../optional-deps')|require('../../optional-deps')|" \
  -e "s|require('../services/registry')|require('../../services/registry')|" \
  -e "s|require('../services')|require('../../services')|" \
  -e "s|require('../ports')|require('../../ports')|" server/trigger/s3/index.js
sed -i '' "s|require('./s3')|require('./s3/index')|" server/trigger/manager.js
sed -i '' "s|require('../server/trigger/s3')|require('../server/trigger/s3/index')|g" tests/*.js
sed -i '' "s|require('./trigger/s3')|require('./trigger/s3/index')|" server/bootstrap.js
```

Run the gate. Everything must pass before a single line is extracted — this proves the move alone is inert.

- [ ] **Step 3: Extract `events.js`**

Move `categoryFor`, `normalizeRecord`, `matchesRoute`, `decodeKey` and the `NOTIFICATION_ID`/`NOTIFICATION_ARN` constants into `server/trigger/s3/events.js`, exporting all of them. These are pure functions over MinIO's webhook payload with no state. In `index.js`:

```js
const { categoryFor, normalizeRecord, matchesRoute, decodeKey } = require('./events');
```

Run the gate.

- [ ] **Step 4: Extract `listener.js` and `bucket-config.js`**

`listener.js` takes `createRequestHandler` and `createListener` plus the `dispatch` helper, importing what it needs from `./events`. `bucket-config.js` takes `buildClient`, `ensureBucket`, `syncBucketNotification`, `ensureBucketConfig`, `queueBucketConfig`, `drainBucketConfigQueue` and the `bucketConfigQueue` map — the S3 SDK lazy-load (`s3Sdk`) goes here too, since this is its only consumer.

`index.js` keeps the driver: the route/status maps, `s3RoutesFor`, `setS3ListenerError`, `routeEquals`, `removeS3Route`, `stop`, `sync`, `status`, `statusAll`, and re-exports `createListener` from `./listener`.

Run the gate after each extraction, not just at the end.

- [ ] **Step 5: Verify the export surface is unchanged**

```bash
node -e "console.log(Object.keys(require('./server/trigger/s3/index')).sort().join('\n'))"
```
Compare against Step 1's list. Any difference is a bug, not a cleanup.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(trigger): split s3 into listener, events, bucket-config and driver

336 lines doing four jobs: the MinIO webhook listener, event
normalisation and route matching, bucket-notification configuration, and
the driver state machine. The export surface is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extract the invoke pipeline

**Files:**
- Modify: `server/api/invoke.js`
- Create: `server/api/invoke-result.js`
- Test: `tests/api.test.js` unchanged; add `tests/invoke-result.test.js`

**Interfaces:**
- Produces: `failureResult({ phase, type, message, logs, report })` returning the `{ ok: false, phase, error, logs, report }` envelope, and `historyEntryFor(fn, input, result, source)`.

**Context:** `invokeFunction` is a ~100-line pipeline — service precheck, build, invoke, history — that hand-builds the same failure envelope three times with slightly different fields, which is exactly how the three copies drift.

- [ ] **Step 1: Write the failing test**

Create `tests/invoke-result.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { failureResult } = require('../server/api/invoke-result');

test('failureResult builds the standard envelope', () => {
  const r = failureResult({ phase: 'build', type: 'Build.Failed', message: 'nope', memoryMb: 256 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'build');
  assert.deepStrictEqual(r.error, { type: 'Build.Failed', message: 'nope', stackTrace: [] });
  assert.strictEqual(r.logs, '');
  assert.strictEqual(r.report.memoryMb, 256);
  assert.strictEqual(r.report.timedOut, false);
  assert.ok(r.report.requestId, 'every failure still gets a request id');
});

test('failureResult carries logs and extra report fields when given them', () => {
  const r = failureResult({
    phase: 'build', type: 'Build.Failed', message: 'nope',
    memoryMb: 128, logs: 'output here', report: { buildMs: 42 },
  });
  assert.strictEqual(r.logs, 'output here');
  assert.strictEqual(r.report.buildMs, 42);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/invoke-result.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/api/invoke-result.js`**

```js
const crypto = require('crypto');

// The failure envelope invokeFunction returns for anything that stops a run
// before (or instead of) the handler executing: a service that isn't up, a
// build that failed. Built in one place because three hand-written copies
// are three chances for the shapes to drift apart.
function failureResult({ phase, type, message, memoryMb, logs = '', report = {} }) {
  return {
    ok: false,
    phase,
    error: { type, message, stackTrace: [] },
    logs,
    report: {
      requestId: crypto.randomUUID(),
      durationMs: 0,
      billedMs: 0,
      memoryMb,
      timedOut: false,
      ...report,
    },
  };
}

module.exports = { failureResult };
```

- [ ] **Step 4: Use it in `invokeFunction`**

Replace the two inline envelopes — the `Service.NotRunning` one and the `Build.Failed` one — with `failureResult(...)` calls. Keep the history-append behaviour identical, including the `try {} catch {}` around the service-failure append.

- [ ] **Step 5: Run the gate**

```bash
node --test tests/invoke-result.test.js
ls tests/*.test.js | grep -v trigger-docker | xargs node --test --test-concurrency=1 --test-timeout=120000
npm run typecheck:server
```
`tests/api.test.js` must pass unchanged — it asserts on these exact envelopes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(api): build the invoke failure envelope in one place

invokeFunction hand-wrote the same {ok,phase,error,logs,report} shape
three times with slightly different fields.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: npm workspaces

**Files:**
- Create: `server/package.json`
- Modify: root `package.json`, `web/src/lib/backend.ts`, `web/package.json`, `scripts/prepare.js`
- Test: `tests/pack.test.js`, `tests/web.test.js`, `tests/dev.test.js`, plus a real `npm pack`

**Context:** `web/src/lib/backend.ts` reaches across the repo with `createRequire`, walks up to eight directories hunting for `server/api/index.js`, re-`stat`s every `.js` under `server/` **on every request** in dev, and returns an untyped `Proxy` behind three `any` escapes. All of it compensates for `server/` not being a package.

**This is the riskiest task in the plan.** `npm install` semantics change, and `scripts/prepare.js` deliberately strips `npm_config_omit` so the root's `--omit=optional` cannot break web's build. Verify against a real clean clone, not just a green suite.

- [ ] **Step 1: Record the current packaging behaviour as the baseline**

```bash
npm pack --dry-run 2>&1 | tee /tmp/pack-before.txt
node --test tests/pack.test.js tests/prepare.test.js
```
Keep `/tmp/pack-before.txt`. The tarball contents must not lose anything.

- [ ] **Step 2: Create `server/package.json`**

```json
{
  "name": "@aws-playground/server",
  "version": "0.1.0",
  "private": true,
  "main": "api/index.js",
  "types": "types.d.ts",
  "exports": {
    ".": { "types": "./types.d.ts", "default": "./api/index.js" },
    "./types": { "types": "./types.d.ts" },
    "./bootstrap": "./bootstrap.js",
    "./ports": "./ports.js"
  }
}
```

- [ ] **Step 3: Declare the workspaces**

In the root `package.json`, add:

```json
  "workspaces": ["server", "web"],
```

Do **not** remove the `prepare` script — installs from a git URL still need it to build `web/dist`.

- [ ] **Step 4: Install and confirm the link**

```bash
npm install --ignore-scripts --no-audit --no-fund
ls -l node_modules/@aws-playground/server
```
Expected: a symlink into `server/`.

- [ ] **Step 5: Rewrite `web/src/lib/backend.ts`**

Replace the whole resolution block. The dev cache-buster goes away: Vite owns invalidation for a linked workspace package.

```ts
import { createRequire } from 'node:module'
import type { ApiResult, FunctionDef, Ports } from '@aws-playground/server/types'

// server/ is CommonJS with no HTTP server of its own -- every route under
// web/src/routes/api.*.ts calls straight into it in-process. It is a linked
// workspace package now, so this is an ordinary resolution rather than a
// walk up the directory tree looking for a file.
const require_ = createRequire(import.meta.url)
const backendModule = require_('@aws-playground/server')

export const backend = backendModule as {
  health(): Promise<ApiResult>
  listFunctions(): ApiResult<{ functions: FunctionDef[] }>
  createFunction(input: unknown): ApiResult<FunctionDef>
  updateFunction(id: string, patch: unknown): ApiResult<FunctionDef>
  deleteFunction(id: string): ApiResult
  detect(input: unknown): ApiResult
  invokeFunction(input: unknown): Promise<ApiResult>
  listHistory(id: string): ApiResult
  clearHistory(id: string): ApiResult
  getInvokeTrace(id: string, requestId: string): ApiResult
  listServices(): Promise<ApiResult>
  startService(name: string): Promise<ApiResult>
  stopService(name: string): Promise<ApiResult>
  setSelection(input: unknown): Promise<ApiResult>
  listTriggerStatus(): ApiResult
  startBootstrap(): Promise<void>
  RUNTIMES: string[]
  PORTS: Ports
}

if (import.meta.env.DEV) {
  backend.startBootstrap?.()
}

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

Add `"@aws-playground/server": "*"` to `web/package.json`'s dependencies.

**If Vite refuses to bundle the CJS package for SSR**, add it to `ssr.external` in `web/vite.config.ts` rather than reverting the typed boundary — the existing `ssr: { noExternal: true }` build-only setting is the likely conflict, and this package must stay external because it is the one thing that must NOT be bundled.

- [ ] **Step 6: Delete the duplicated web types**

`web/src/lib/types.ts` re-declares `Runtime`, `SavedEvent`, `FunctionTrigger`, `FunctionDef` and `Ports`. Replace those five with re-exports:

```ts
export type {
  Runtime, SavedEvent, FunctionTrigger, FunctionDef, Ports,
} from '@aws-playground/server/types'
```

Everything else in that file (`InvokeResult`, `HistoryEntry`, `Detection`, `ResultTab`, …) is web-only and stays.

- [ ] **Step 7: Verify dev, build and pack**

```bash
npm --prefix web run typecheck
npm --prefix web run test
npm run typecheck:server
node --test tests/dev.test.js tests/web.test.js
npm --prefix web run build
npm pack --dry-run 2>&1 | tee /tmp/pack-after.txt
diff <(grep -oE '[a-z0-9./-]+$' /tmp/pack-before.txt | sort) \
     <(grep -oE '[a-z0-9./-]+$' /tmp/pack-after.txt | sort)
```
The diff should show `server/package.json` added and nothing removed. **Anything missing from the tarball is a release-breaking regression** — fix the root `files` array before continuing.

- [ ] **Step 8: Verify a clean clone still installs**

```bash
rm -rf /tmp/awsplay-clone && git clone -q . /tmp/awsplay-clone
cd /tmp/awsplay-clone && npm install --no-audit --no-fund 2>&1 | tail -20
ls web/dist/server/server.js && node bin/cli.js --help
cd -
```
Expected: install succeeds, `web/dist` is built, `--help` prints. This is the check the unit suite cannot make.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: make server/ a workspace package with a typed boundary

backend.ts walked up to eight directories hunting for server/api/index.js,
re-stat'd every server .js file on every dev request, and returned an
any-typed Proxy. server/ is a linked package now, so resolution is
ordinary and the API surface is typed on both sides. web/src/lib/types.ts
re-exports the server's types instead of re-declaring them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Split the test suite by isolation requirement

**Files:**
- Move: `tests/*.test.js` → `tests/unit/` and `tests/integration/`
- Modify: `package.json` scripts, `.github/workflows/ci.yml`, `tests/helpers.js` path references
- Create: `tests/integration/exclusive-ports.js`

**Context:** 39 files run fully serially, though only some need it. Worse, the docker-backed files use fixed container names (`aws-playground-minio`) and fixed ports 9400–9404, so **two concurrent runs wedge each other** — that is what produced a 1h40m hung process during Phase A. Today that failure is a silent hang.

**Integration (serial, exclusive):** `trigger-docker`, `services-docker`, `services`, `trigger-s3`, `trigger-sqs`, `trigger-dynamodb`, `trigger-manager`, `http-trigger-e2e`, `cli`, `dev`, `web`, `pack`, `prepare`, `fixtures-install`, `java`, and every `harness-*`.
**Unit (parallel):** everything else — `schema`, `ports`, `store`, `history`, `atomic-write`, `detect`, `envfile`, `otlp-decode`, `node-version`, `projectconfig`, `effective-trigger`, `trace-collector`, `trace-receiver`, `trigger-poller`, `auto-trace-detect`, `invoke-result`, `build`, `api`, `http-trigger`, `bootstrap`, `invoker`, `auto-trace-bootstrap`.

Put a file in `integration/` if you are unsure. A misfiled parallel test is a flaky suite; a misfiled serial test is only slow.

- [ ] **Step 1: Move the files**

```bash
mkdir -p tests/unit tests/integration
git mv tests/{trigger-docker,services-docker,services,trigger-s3,trigger-sqs,trigger-dynamodb,trigger-manager,http-trigger-e2e,cli,dev,web,pack,prepare,fixtures-install,java}.test.js tests/integration/
git mv tests/harness-*.test.js tests/integration/
git mv tests/*.test.js tests/unit/
```

Fix the `../server/...` requires — they gain a level:

```bash
sed -i '' -E "s|require\('\.\./server/|require('../../server/|g" tests/unit/*.js tests/integration/*.js
sed -i '' -E "s|require\('\./helpers'\)|require('../helpers')|g" tests/unit/*.js tests/integration/*.js
```

Check for other `..`-relative paths (fixtures, `__dirname` joins) with:

```bash
grep -rn "\.\./" tests/unit tests/integration | grep -v "require('\.\./\.\./server\|require('\.\./helpers" | head -40
```
Fix each — `path.join(__dirname, '..', 'fixtures')` becomes `'..', '..', 'fixtures'`.

- [ ] **Step 2: Add the exclusive-port guard**

Create `tests/integration/exclusive-ports.js`:

```js
const net = require('node:net');
const { PORTS } = require('../../server/ports');

// The docker-backed integration tests use fixed container names and fixed
// ports, so two concurrent runs fight over them. That used to surface as a
// silent hour-long hang; fail immediately with the reason instead.
function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

async function assertPortsFree(names) {
  const taken = [];
  for (const name of names) {
    if (await portInUse(PORTS[name])) taken.push(`${name} (${PORTS[name]})`);
  }
  if (taken.length) {
    throw new Error(
      `these ports are already in use: ${taken.join(', ')}. Another test run or a `
      + 'playground instance is holding them — the docker-backed tests need exclusive '
      + 'access. Stop it and retry.');
  }
}

module.exports = { assertPortsFree, portInUse };
```

Call it at the top of `tests/integration/trigger-docker.test.js` and `tests/integration/services-docker.test.js`:

```js
const { assertPortsFree } = require('./exclusive-ports');

test('the ports these tests need are free', async () => {
  await assertPortsFree(['minio', 'minioConsole', 'dynamodb', 's3Webhook']);
});
```

Note this must be a `test(...)`, not a bare top-level `await` — the file is CommonJS and a throw at require time reports as an unhelpful module-load failure.

- [ ] **Step 3: Update the scripts**

```json
    "test:server": "npm run test:unit && npm run test:integration",
    "test:unit": "node --test tests/unit/",
    "test:integration": "node --test --test-concurrency=1 --test-timeout=120000 tests/integration/",
```

`tests/unit/` drops `--test-concurrency=1`; that is the point. It keeps `--test-timeout` off so a genuinely hung unit test still surfaces via CI's job timeout.

- [ ] **Step 4: Run both tiers**

```bash
npm run test:unit
npm run test:integration
```
Expected: unit passes and is noticeably faster. Integration passes except the known-broken `trigger-docker`. **If a unit test fails only under parallelism, move it to `integration/` — do not add sleeps.**

- [ ] **Step 5: Update CI**

Replace the single "Server tests" step with the two tiers so a failure names which tier broke:

```yaml
      - name: Server tests (unit)
        run: npm run test:unit

      - name: Server tests (integration)
        run: npm run test:integration
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: split the suite by isolation requirement

39 files ran fully serially though only some need it. The docker-backed
tests use fixed container names and fixed ports, so two concurrent runs
wedge each other -- previously a silent hang, now an immediate error
naming the held ports.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Stop committing build artifacts

**Files:**
- Delete from git (keep on disk): `harnesses/java/harness.jar`, `fixtures/**/dist/`, `fixtures/**/target/`
- Modify: `.gitignore`, `scripts/prepare.js`, `harnesses/java/build.sh`
- Test: `tests/integration/prepare.test.js`, `tests/integration/pack.test.js`

**Context:** A compiled `.jar` in git is opaque to review and to `git log`. `harnesses/java/build.sh` already exists. The tarball must still ship the jar — users are not expected to have a JDK — so only the git-tracked copy goes away.

- [ ] **Step 1: Untrack them**

```bash
git rm --cached harnesses/java/harness.jar
git rm -r --cached fixtures/java/hello/target fixtures/java/structured-logging/target
for d in fixtures/typescript/*/dist; do git rm -r --cached "$d"; done
```

Append to `.gitignore`:

```
# Built by scripts/prepare.js and the fixture install; shipped in the npm
# tarball but never committed.
harnesses/java/harness.jar
fixtures/**/target/
fixtures/typescript/*/dist/
```

- [ ] **Step 2: Build the harness jar during prepare**

In `scripts/prepare.js`, after the web build, add a Java step that degrades gracefully:

```js
// The harness jar ships in the npm tarball but is not committed, so a
// source checkout builds it here. No JDK is not an error: every Java test
// already skips without one, and every non-Java runtime still works.
function buildJavaHarness(root) {
  const jar = path.join(root, 'harnesses', 'java', 'harness.jar');
  if (fs.existsSync(jar)) return;
  const probe = spawnSync('javac', ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (probe.status !== 0) {
    console.error('aws-playground: no JDK found — skipping the Java harness build. '
      + 'Java functions will be unavailable; every other runtime works.');
    return;
  }
  const res = spawnSync('sh', [path.join(root, 'harnesses', 'java', 'build.sh')],
    { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('aws-playground: the Java harness build failed — Java functions will be unavailable.');
  }
}
```

Call it from `main()` after the web build. Note it is **not** fatal — `process.exit` here would make a missing JDK block the whole install.

- [ ] **Step 3: Confirm `build.sh` writes where the invoker looks**

```bash
cat harnesses/java/build.sh
rm -f harnesses/java/harness.jar
sh harnesses/java/build.sh && ls -l harnesses/java/harness.jar
```
`server/runtime/invoker.js` expects `harnesses/java/harness.jar`. If `build.sh` writes elsewhere, fix `build.sh`, not the invoker.

- [ ] **Step 4: Confirm the tarball still ships it**

```bash
npm pack --dry-run 2>&1 | grep -E "harness.jar|harnesses/"
```
Expected: `harnesses/java/harness.jar` present. It is covered by the `files` array's `harnesses` entry, and `.gitignore` does not affect `npm pack` when a path is explicitly included — **verify rather than assume**, since npm's ignore rules are subtle.

- [ ] **Step 5: Run the gate**

```bash
npm run test:unit && npm run test:integration
```
`tests/integration/java.test.js` exercises the built jar; if it now skips where it used to run, the build step is not working.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
build: build the Java harness instead of committing the jar

A compiled jar in git is opaque to review and to git log. prepare builds
it from harnesses/java/build.sh, skipping with a clear message when no
JDK is present. The npm tarball still ships it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `ARCHITECTURE.md`

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Modify: `README.md` (one link, under "Development")

**Context:** `README.md` is 21KB of user-facing documentation. The design decisions a contributor needs — the in-process CJS backend, the trigger driver contract, the harness protocol, where state lives — are explained only in scattered code comments.

- [ ] **Step 1: Write it**

Cover, with a short section each:

1. **Process model** — one Node process; the TanStack Start SSR server serves the UI *and* calls `server/` in-process via the workspace package; there is no second API process. Why: a playground that needed two processes to start would be a worse tool.
2. **Module map** — `api/` (request handlers returning `{status, body}`), `runtime/` (launching handlers), `trigger/` (event sources), `services/` (docker-backed local AWS), `persistence/` (on-disk state), `trace/` (span capture), `schema/` (the one owner of the function and trigger shapes), `ports.js`, `bootstrap.js`.
3. **The trigger driver contract** — `{ type, sync, stop, status, statusAll }`; `manager.js` owns the list; adding a source is one new module plus one array entry.
4. **The harness protocol** — how an invoke reaches a handler in each runtime, and what the result envelope looks like. **Update this in Phase D when warm environments change it.**
5. **Where state lives** — `~/.aws-playground/functions.json` and `history/*.jsonl`, both written atomically; `playground.json` in the user's project, re-read on every use and authoritative over UI toggles.
6. **Entry points** — `bin/cli.js` and `vite dev`, both calling `server/bootstrap.js`.

Link to the specs in `docs/superpowers/specs/` rather than restating them.

- [ ] **Step 2: Link it from the README**

Under `## Development`, one line:

```markdown
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md README.md
git commit -m "$(cat <<'EOF'
docs: describe the architecture for contributors

The in-process CJS backend, the trigger driver contract and the harness
protocol were explained only in scattered code comments.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

- [ ] `npm run test:unit` passes, and runs in parallel
- [ ] `npm run test:integration` passes except the known-broken `trigger-docker`
- [ ] `npm run test:web` passes
- [ ] `npm run typecheck:server` and `npm --prefix web run typecheck` pass
- [ ] `npm run lint` reports no *new* errors (two pre-existing ones remain)
- [ ] `ls server/*.js` shows only `bootstrap.js`, `ports.js`, `serve-web.js`, `optional-deps.js`
- [ ] `grep -c "createRequire" web/src/lib/backend.ts` is 1, and the file has no `any`
- [ ] `git ls-files | grep -E "harness.jar|fixtures/.*/(dist|target)/"` returns nothing
- [ ] `npm pack --dry-run` still lists `harnesses/java/harness.jar`
- [ ] A clean clone installs and `node bin/cli.js --help` runs
