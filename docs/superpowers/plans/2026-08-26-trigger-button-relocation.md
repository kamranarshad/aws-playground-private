# Trigger Button Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move trigger configuration out of the Settings dialog into its own button/modal in the function header, and let `playground.json` declare a trigger the same way it already declares local services — file wins over manual config, shown read-only in the UI.

**Architecture:** `server/projectconfig.js` (the existing `playground.json` reader) gains `trigger` parsing alongside its existing `services` parsing. A new `server/trigger/effective.js` computes the merged "what's actually running" value the trigger manager uses; `server/detect.js` exposes the raw file declaration (no merge) as `projectTrigger`, the same way it already exposes `projectServices`, so the web UI can decide whether to show the interactive picker or a read-only label. The web side gets a new `TriggerButton` component (relocated from `SettingsDialog`), mounted in `FunctionHeader`.

**Tech Stack:** No new dependencies — this plan only touches existing modules and adds two new small files (one server, one web).

**Spec:** `docs/superpowers/specs/2026-08-26-trigger-button-relocation-design.md`

## Global Constraints

- A `playground.json`-declared trigger overrides whatever's manually stored on the function (`fn.trigger`) — identical precedence to `effectiveServices`.
- `playground.json` triggers have no `enabled` field — presence in the file means enabled, matching how a service listed in `services` has no independent toggle. The parser stamps `enabled: true` onto whatever it returns.
- No live file-watching. A file trigger is picked up at the same points `manager.sync(fn)` already runs: function create, function update, and server startup (`resumeAll`) — not instantly on file edit.
- Trigger configuration is removed from the Settings dialog entirely, not duplicated — it lives only in the new `TriggerButton` component.
- The new button sits in `FunctionHeader`, on the right, next to `SettingsDialog` (before it, so the order reads Trigger → Settings → Delete). The existing `TriggerStatusBadge` (left side, passive status) is untouched and unmoved.
- When `playground.json` declares a trigger, the button becomes a non-interactive, read-only label instead — the exact treatment `LocalServiceToggles` already gives a file-declared service list, including the tooltip text `"Declared in playground.json — edit the file to change"`.
- `server/api/functions.js`'s trigger validation (name uniqueness, `/`-in-name, shape checks) is unchanged — it only ever governs what's written through the API, and `playground.json` triggers never go through the API.

---

## Task 1: `playground.json` trigger parsing

**Files:**
- Modify: `server/projectconfig.js`
- Test: `tests/projectconfig.test.js`

**Interfaces:**
- Produces: `read(dir)` now returns `{ services: string[] | null, trigger: { type: 'sqs', queueName: string, enabled: true } | { type: 'http', enabled: true } | null }` — `trigger` is a new field; `services`' existing behavior is unchanged, but every call site in this codebase that already destructures `read(dir).services` continues to work since that field's shape and semantics are untouched.

- [ ] **Step 1: Write the failing tests**

Replace `tests/projectconfig.test.js` in full with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { read } = require('../server/projectconfig');

function proj(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-pc-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'playground.json'), content);
  return dir;
}

test('valid services list is returned', () => {
  const dir = proj(JSON.stringify({ services: ['minio', 'elasticmq'] }));
  assert.deepStrictEqual(read(dir), { services: ['minio', 'elasticmq'], trigger: null });
});

test('unknown service names are filtered out', () => {
  const dir = proj(JSON.stringify({ services: ['minio', 'fakeservice', 'redis'] }));
  assert.deepStrictEqual(read(dir), { services: ['minio', 'redis'], trigger: null });
});

test('missing file, invalid JSON, and non-array services yield null', () => {
  assert.deepStrictEqual(read(proj()), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj('{not json')), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ services: 'minio' }))), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ other: 1 }))), { services: null, trigger: null });
});

test('valid sqs trigger is returned with enabled stamped true', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs', queueName: 'my-queue' } }));
  assert.deepStrictEqual(read(dir),
    { services: null, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } });
});

test('valid http trigger is returned with enabled stamped true', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'http' } }));
  assert.deepStrictEqual(read(dir), { services: null, trigger: { type: 'http', enabled: true } });
});

test('sqs trigger without a queueName is rejected', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs' } }));
  assert.deepStrictEqual(read(dir), { services: null, trigger: null });
});

test('unknown trigger type, missing trigger, and non-object trigger all yield null', () => {
  assert.deepStrictEqual(read(proj(JSON.stringify({ trigger: { type: 'sns' } }))),
    { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ other: 1 }))), { services: null, trigger: null });
  assert.deepStrictEqual(read(proj(JSON.stringify({ trigger: 'http' }))), { services: null, trigger: null });
});

test('services and trigger are both read independently from the same file', () => {
  const dir = proj(JSON.stringify({ services: ['minio'], trigger: { type: 'http' } }));
  assert.deepStrictEqual(read(dir), { services: ['minio'], trigger: { type: 'http', enabled: true } });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/projectconfig.test.js`
Expected: FAIL — every assertion expecting a `trigger` key fails (the current `read()` never returns one), including the three pre-existing `services`-only tests, since their expected objects now also lack the `trigger: null` key the real return value doesn't have yet.

- [ ] **Step 3: Implement trigger parsing**

Replace `server/projectconfig.js` in full with:

```js
const fs = require('fs');
const path = require('path');
const services = require('./services');

function parseTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'sqs') {
    return typeof raw.queueName === 'string' && raw.queueName.trim()
      ? { type: 'sqs', queueName: raw.queueName, enabled: true }
      : null;
  }
  if (raw.type === 'http') return { type: 'http', enabled: true };
  return null;
}

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
    trigger: parseTrigger(parsed?.trigger),
  };
}

module.exports = { read };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/projectconfig.test.js`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/projectconfig.js tests/projectconfig.test.js
git commit -m "feat(config): parse a trigger declaration from playground.json"
```

---

## Task 2: `effectiveTrigger` helper

**Files:**
- Create: `server/trigger/effective.js`
- Test: `tests/effective-trigger.test.js`

**Interfaces:**
- Consumes: `projectconfig.read(dir)` (Task 1) — specifically its `trigger` field.
- Produces: `effectiveTrigger(fn: { path: string, trigger: FunctionTrigger | null }) -> FunctionTrigger | null`, where `FunctionTrigger` is the existing server-side shape `{ type: 'sqs', queueName: string, enabled: boolean } | { type: 'http', enabled: boolean }`. Used by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/effective-trigger.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { effectiveTrigger } = require('../server/trigger/effective');

function proj(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-eff-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'playground.json'), content);
  return dir;
}

test('a playground.json trigger wins over the manually-stored one', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'http' } }));
  const fn = { path: dir, trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'http', enabled: true });
});

test('falls back to the manually-stored trigger when playground.json declares none', () => {
  const dir = proj(); // no playground.json at all
  const fn = { path: dir, trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'sqs', queueName: 'manual-queue', enabled: true });
});

test('returns null when neither playground.json nor the function declares a trigger', () => {
  const dir = proj();
  const fn = { path: dir, trigger: null };
  assert.strictEqual(effectiveTrigger(fn), null);
});

test('an invalid playground.json trigger falls back to the manual one, not null', () => {
  const dir = proj(JSON.stringify({ trigger: { type: 'sqs' } })); // missing queueName -> invalid
  const fn = { path: dir, trigger: { type: 'http', enabled: true } };
  assert.deepStrictEqual(effectiveTrigger(fn), { type: 'http', enabled: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/effective-trigger.test.js`
Expected: FAIL with `Cannot find module '../server/trigger/effective'`.

- [ ] **Step 3: Implement**

Create `server/trigger/effective.js`:

```js
const projectconfig = require('../projectconfig');

// A function's trigger, resolved the same way effectiveServices resolves
// local services: a playground.json declaration wins outright over
// whatever's manually stored on the function (fn.trigger, written through
// the trigger-button UI). Re-read fresh on every call — never cached —
// since the file can change without the function being re-saved.
function effectiveTrigger(fn) {
  return projectconfig.read(fn.path).trigger ?? fn.trigger ?? null;
}

module.exports = { effectiveTrigger };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/effective-trigger.test.js`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/trigger/effective.js tests/effective-trigger.test.js
git commit -m "feat(trigger): add the effectiveTrigger playground.json/manual merge"
```

---

## Task 3: Wire `effectiveTrigger` into the trigger manager

**Files:**
- Modify: `server/trigger/manager.js`
- Test: `tests/trigger-manager.test.js`

**Interfaces:**
- Consumes: `effectiveTrigger(fn)` (Task 2).
- Produces: no change to `manager.js`'s public exports (`sync`, `stop`, `resumeAll`, `stopAll`, `status`, `statusAll`) — same signatures, same callers, no changes needed anywhere else.

This task fixes two things inside `sync(fn)`, both required for `effectiveTrigger` to actually work end-to-end, not just to be called:

1. `sync(fn)` must branch on `effectiveTrigger(fn)`, not `fn.trigger` directly.
2. The SQS path's `startFor(fn)` (and everything it calls — `sqs.start`, `sqs.js`'s internals) reads `fn.trigger.queueName` directly from the `fn` object it's given, not from a separately-passed value. If a function's SQS trigger comes from `playground.json` while `fn.trigger` itself is `null` (or has different SQS settings), calling `startFor(fn)` unmodified would either throw (`null.queueName`) or use the wrong queue. Fix: when starting the SQS path, pass `startFor` a shallow-copied function object with `trigger` overridden to the resolved effective trigger — `startFor({ ...fn, trigger })` — so every downstream read of `fn.trigger.queueName` (inside `startFor`, `sqs.start`, `sqs.js`'s `runLoop`) sees the correct, effective value without any of those files needing to change.
3. A `/` in a function's `name` breaks HTTP-trigger routing (the router splits on the first `/`) — `server/api/functions.js` already refuses to let this happen for a *manually* enabled HTTP trigger, but that check only runs when a trigger is written through the API, and a `playground.json` trigger never is. Guard against it here too: if the effective trigger is HTTP and `fn.name` contains `/`, treat it as inert (skip registering a route) rather than corrupting `httpRoutes`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/trigger-manager.test.js`:

```js
test('sync resolves an sqs trigger declared only in playground.json (fn.trigger stays null)', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff-'));
    fs.writeFileSync(path.join(dir, 'playground.json'),
      JSON.stringify({ trigger: { type: 'sqs', queueName: 'from-file' } }));
    let startedQueueName;
    sqs.start = (fn, { onStatus }) => {
      startedQueueName = fn.trigger.queueName;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    const fn = store.create({ name: 'eff-sqs', path: dir, runtime: 'node' }); // no manual trigger

    await manager.sync(fn);

    assert.strictEqual(startedQueueName, 'from-file');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync resolves an http trigger declared only in playground.json, overriding a manual sqs one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff2-'));
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  let httpCalls = 0;
  httpTrigger.createListener = async () => {
    httpCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'eff-http', path: dir, runtime: 'node',
      trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } });

    await manager.sync(fn);

    assert.strictEqual(httpCalls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('a name containing "/" is never registered as an http route, even via playground.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff3-'));
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  let listenerCalls = 0;
  httpTrigger.createListener = async () => {
    listenerCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'has/slash', path: dir, runtime: 'node' });

    await manager.sync(fn);

    assert.strictEqual(listenerCalls, 0, 'no listener should ever start for an unroutable name');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});
```

No new requires are needed — `fs`, `os`, `path`, `store`, `localServices`, `sqs`, `httpTrigger`, and `originalCreateListener` are all already imported/declared at the top of `tests/trigger-manager.test.js` (lines 1-30), reused as-is by the new tests above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/trigger-manager.test.js`
Expected: FAIL — `sync()` still reads `fn.trigger` directly, so the playground.json-only trigger is invisible (functions stay `idle`), and the `/`-in-name guard doesn't exist yet (the third test's `httpTrigger.createListener` would actually get called, since nothing stops it).

- [ ] **Step 3: Implement**

In `server/trigger/manager.js`, add the import near the top:

```js
const { effectiveTrigger } = require('./effective');
```

Replace the `sync` function with:

```js
async function sync(fn) {
  const trigger = effectiveTrigger(fn);
  // Clean up any stale registration under the *other* trigger type first —
  // covers switching sqs <-> http on the same function.
  if (trigger?.type !== 'http' && httpTriggered.has(fn.id)) stopHttp(fn.id);
  if (trigger?.type !== 'sqs' && running.has(fn.id)) stopSqs(fn.id);

  if (trigger?.type === 'sqs') {
    const shouldRun = !!trigger.enabled;
    const current = running.get(fn.id);
    if (!shouldRun) {
      if (current) stopSqs(fn.id);
      return;
    }
    if (current && current.queueName === trigger.queueName && current.status.state !== 'error') return;
    if (current) stopSqs(fn.id);
    // startFor (and everything it calls) reads fn.trigger.queueName directly
    // off the object it's given — pass the resolved effective trigger
    // through fn so a playground.json-only sqs trigger (where fn.trigger
    // itself may be null or different) still reaches the right queue.
    await startFor({ ...fn, trigger });
    return;
  }

  if (trigger?.type === 'http') {
    // A '/' in the name can never be routed (the listener splits on the
    // first path segment) — the API refuses to let a *manual* trigger be
    // enabled against such a name, but a playground.json trigger bypasses
    // that check entirely. Treat it as inert rather than corrupt the
    // shared route table.
    if (!trigger.enabled || fn.name.includes('/')) { stopHttp(fn.id); return; }
    await syncHttp(fn);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/trigger-manager.test.js`
Expected: PASS — every pre-existing SQS/HTTP test plus the 3 new ones.

Also run the full trigger-related regression:

Run: `node --test --test-concurrency=1 tests/api.test.js tests/trigger-manager.test.js tests/trigger-sqs.test.js tests/http-trigger.test.js tests/effective-trigger.test.js tests/projectconfig.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/trigger/manager.js tests/trigger-manager.test.js
git commit -m "feat(trigger): resolve triggers through effectiveTrigger, guard unroutable names"
```

---

## Task 4: `projectTrigger` in project detection, and the README

**Files:**
- Modify: `server/detect.js`
- Test: `tests/detect.test.js`
- Modify: `README.md`

**Interfaces:**
- Produces: `detectProject(dir)`'s return value gains `projectTrigger: { type: 'sqs', queueName: string, enabled: true } | { type: 'http', enabled: true } | null` — the *raw* file declaration (same as `projectServices`), not merged with any function's manual trigger. This is what the web UI (Task 5) reads to decide whether to show the picker or the read-only label.

- [ ] **Step 1: Write the failing tests**

Append to `tests/detect.test.js`:

```js
test('projectTrigger reflects a playground.json-declared trigger', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'), 'def handler(event, context):\n    return {}\n');
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  const res = detectProject(dir);
  assert.deepStrictEqual(res.projectTrigger, { type: 'http', enabled: true });
});

test('projectTrigger is null when playground.json declares none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'), 'def handler(event, context):\n    return {}\n');
  const res = detectProject(dir);
  assert.strictEqual(res.projectTrigger, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/detect.test.js`
Expected: FAIL — `res.projectTrigger` is `undefined`, not the expected values.

- [ ] **Step 3: Implement**

In `server/detect.js`, replace the end of `detectProject`:

```js
  return { runtime, handlerCandidates, venvPython, jarPath,
    envFiles: envfile.list(dir), buildCommand,
    projectServices: projectconfig.read(dir).services };
```

with (reading `playground.json` once, not twice):

```js
  const projectConfig = projectconfig.read(dir);
  return { runtime, handlerCandidates, venvPython, jarPath,
    envFiles: envfile.list(dir), buildCommand,
    projectServices: projectConfig.services,
    projectTrigger: projectConfig.trigger };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/detect.test.js`
Expected: PASS (all tests in the file, including the 2 new ones).

- [ ] **Step 5: Update the README**

In `README.md`, insert this new paragraph immediately after the existing paragraph that ends "...stopping a container from a terminal is reflected in the UI within a few seconds." (the paragraph documenting `playground.json`'s `services` declaration) and before the paragraph beginning "A project's `.env` file is loaded automatically...":

```markdown
A `playground.json` can declare a trigger the same way it declares
services — `{"trigger": {"type": "http"}}` or `{"trigger": {"type": "sqs",
"queueName": "my-queue"}}` — and it overrides whatever's set manually for
that function, the same "file wins" rule services follow. The trigger
button in the function header shows this as a read-only label instead of
the interactive picker when a file declaration is present. Like services,
this is read fresh on every use, not cached — but unlike services (which
re-evaluate on every function selection), a trigger's file declaration is
picked up at the same points the playground would otherwise start or stop
it: registering the function, saving any change to it, or restarting the
playground. A hand-edit to `playground.json` for an already-registered,
otherwise-untouched function won't take effect until one of those happens.
```

- [ ] **Step 6: Commit**

```bash
git add server/detect.js tests/detect.test.js README.md
git commit -m "feat(detect): expose a playground.json trigger declaration; document it"
```

---

## Task 5: Web types and the `TriggerButton` component

**Files:**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/components/trigger-button.tsx`
- Test: `web/src/components/trigger-button.test.tsx`

**Interfaces:**
- Consumes: `FunctionTrigger`, `FunctionDef` (existing types); `useDetect`, `useUpdateFunction` (existing hooks in `web/src/lib/queries.ts`).
- Produces: `export function TriggerButton({ fn }: { fn: FunctionDef })` — a self-contained component with no other props. Task 6 (`function-header.tsx`) mounts it directly with just `fn`.

- [ ] **Step 1: Add the type field**

In `web/src/lib/types.ts`, add `projectTrigger` to the `Detection` interface:

```ts
export interface Detection {
  error?: string
  runtime: Runtime | null
  handlerCandidates: string[]
  venvPython?: string | null
  jarPath?: string | null
  envFiles?: string[]
  buildCommand?: string | null
  projectServices?: string[] | null
  projectTrigger?: FunctionTrigger | null
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/components/trigger-button.test.tsx`:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn(), detect: vi.fn() },
}))

import { TriggerButton } from '@/components/trigger-button'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
  vi.mocked(api.detect).mockResolvedValue({ runtime: 'node', handlerCandidates: [], projectTrigger: null })
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function openPicker() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Configure trigger' }))
  return user
}

it('opens the picker when no playground.json trigger is declared', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  await openPicker()
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})

it('seeds the trigger fields from the function', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openPicker()
  expect(screen.getByLabelText('SQS trigger queue')).toHaveValue('my-queue')
  expect(screen.getByRole('checkbox', { name: /invoke automatically/i })).toBeChecked()
})

it('saves an sqs trigger through the patch', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'SQS queue' }))
  await user.type(screen.getByLabelText('SQS trigger queue'), 'new-queue')
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'sqs', queueName: 'new-queue', enabled: true },
  })
})

it('saves an http trigger through the patch, computing the URL from the function name', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'HTTP (API Gateway)' }))
  expect(screen.getByLabelText('HTTP trigger URL')).toHaveValue('http://localhost:9500/test/...')
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'http', enabled: true },
  })
})

it('clears the trigger when switched back to None', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'None' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { trigger: null })
})

it('shows a read-only label instead of the picker when playground.json declares a trigger', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  expect(await screen.findByTitle('Declared in playground.json — edit the file to change'))
    .toHaveTextContent('http')
  expect(screen.queryByRole('button', { name: 'Configure trigger' })).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix web run test -- trigger-button`
Expected: FAIL with `Failed to resolve import "@/components/trigger-button"`.

- [ ] **Step 4: Implement the component**

Create `web/src/components/trigger-button.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDetect, useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const HTTP_TRIGGER_PORT = 9500 // must match server/trigger/http.js's PORT

type TriggerType = 'none' | 'sqs' | 'http'

// Trigger configuration for a function — invoked automatically from an SQS
// queue or an HTTP request instead of only manually. A project
// playground.json wins over whatever's set here, the same way it wins over
// the local-service toggles, so when one is present this renders a
// read-only label instead of the picker — a control that couldn't change
// anything would be a lie.
export function TriggerButton({ fn }: { fn: FunctionDef }) {
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)

  if (projectTrigger != null) {
    return (
      <span
        className="flex items-center gap-1 rounded bg-surface-strip px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
        title="Declared in playground.json — edit the file to change"
      >
        {projectTrigger.type}
      </span>
    )
  }

  return <TriggerPicker fn={fn} />
}

function TriggerPicker({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [triggerType, setTriggerType] = useState<TriggerType>(fn.trigger?.type ?? 'none')
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
  const [triggerEnabled, setTriggerEnabled] = useState(fn.trigger?.enabled ?? false)
  const update = useUpdateFunction()

  useEffect(() => {
    // Re-seed from `fn` whenever the dialog opens — same reason
    // SettingsDialog does this for its own fields: React Query's
    // structural sharing can keep the same `fn` reference across a
    // refetch that changes nothing, so an effect keyed only on `fn`
    // identity can miss a reset.
    if (!open) return
    setTriggerType(fn.trigger?.type ?? 'none')
    setTriggerQueueName(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
    setTriggerEnabled(fn.trigger?.enabled ?? false)
  }, [open, fn])

  function save() {
    update.mutate(
      {
        id: fn.id,
        patch: {
          trigger: triggerType === 'sqs'
            ? (triggerQueueName.trim()
              ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled: triggerEnabled }
              : null)
            : triggerType === 'http'
              ? { type: 'http', enabled: triggerEnabled }
              : null,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Configure trigger">
          <Webhook className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="t-trigger-type">Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
              <SelectTrigger id="t-trigger-type" size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="sqs">SQS queue</SelectItem>
                <SelectItem value="http">HTTP (API Gateway)</SelectItem>
              </SelectContent>
            </Select>
            {triggerType === 'sqs' && (
              <>
                <Label htmlFor="t-trigger-queue">SQS trigger queue</Label>
                <Input id="t-trigger-queue" value={triggerQueueName}
                  onChange={(e) => setTriggerQueueName(e.target.value)}
                  spellCheck={false} placeholder="queue name (empty = no trigger)" />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={triggerEnabled} disabled={!triggerQueueName.trim()}
                    onCheckedChange={(v) => setTriggerEnabled(v === true)} />
                  Invoke automatically when a message arrives
                </label>
                <p className="text-xs text-muted-foreground">
                  Auto-starts the local SQS service (ElasticMQ) and creates the queue if it doesn't exist.
                </p>
              </>
            )}
            {triggerType === 'http' && (
              <>
                <Label htmlFor="t-trigger-url">HTTP trigger URL</Label>
                <Input id="t-trigger-url" readOnly
                  value={`http://localhost:${HTTP_TRIGGER_PORT}/${fn.name}/...`}
                  spellCheck={false} onFocus={(e) => e.target.select()} />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={triggerEnabled}
                    onCheckedChange={(v) => setTriggerEnabled(v === true)} />
                  Invoke automatically on incoming requests
                </label>
                <p className="text-xs text-muted-foreground">
                  Shares one listener on port {HTTP_TRIGGER_PORT} across every function with an
                  HTTP trigger enabled, routed by name — names must be unique.
                </p>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

Note: unlike the old `SettingsDialog` trigger section, the HTTP URL preview here uses `fn.name` directly, not a live-edited local `name` field — renaming a function is `SettingsDialog`'s job, not this dialog's, so there's no local name state to compute the preview from.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test -- trigger-button`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/types.ts web/src/components/trigger-button.tsx web/src/components/trigger-button.test.tsx
git commit -m "feat(web): add the TriggerButton component"
```

---

## Task 6: Remove the trigger section from Settings

**Files:**
- Modify: `web/src/components/settings-dialog.tsx`
- Modify: `web/src/components/settings-dialog.test.tsx`

**Interfaces:**
- Produces: `SettingsDialog`'s `save()` patch no longer includes a `trigger` key at all (not even `null`) — omitting the key leaves the function's trigger untouched server-side, since `updateFunction`'s patch only applies keys that are present.

- [ ] **Step 1: Write the failing tests (by removing the ones that no longer apply)**

Replace `web/src/components/settings-dialog.test.tsx` in full with:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn() },
}))

import { SettingsDialog } from '@/components/settings-dialog'
import { api } from '@/lib/api'
import { useFunctions } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
  vi.mocked(api.listFunctions).mockResolvedValue({ functions: [fn] })
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function openSettings() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Function settings' }))
  return user
}

// Mirrors how FunctionHeader passes cache data down: `fn` comes from a live
// useFunctions() query, not a prop the test controls directly. This matters
// for the reopen-reset regression below, since it's the query's object
// identity (not just its values) that the bug depends on.
function HostFromLiveQuery() {
  const { data } = useFunctions()
  const live = data?.[0]
  return live ? <SettingsDialog fn={live} /> : null
}

it('opens as a modal showing the current name', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  await openSettings()
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveValue('test')
})

it('saves the trimmed name through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.type(input, '  renamed  ')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ name: 'renamed' }))
})

it('keeps the current name when the field is left blank', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ name: 'test' }))
})

it('reseeds the Name field from the live function when reopened after a blank-name save', async () => {
  // The blank-name save patches the function with its own unchanged name, so
  // the refetch triggered by the mutation resolves to the same `fn` object
  // (mockResolvedValue keeps returning the same reference every call, the
  // same effect React Query's structural sharing produces in the real app
  // for a value-for-value-identical refetch). A reset effect keyed only on
  // `[fn]` never reruns in that case, so the Name field — left blank by the
  // user's edit — stays blank the next time the dialog opens, even though
  // the sidebar/header/server all show the correct, unchanged name.
  render(<HostFromLiveQuery />, { wrapper: makeWrapper() })

  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

  await openSettings()
  const reopened = await screen.findByLabelText('Name')
  await waitFor(() => expect(reopened).toHaveValue('test'))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix web run test -- settings-dialog`
Expected: FAIL — `screen.getByLabelText('Name')` etc. still work today (the component hasn't changed yet), so the 4 tests above should actually PASS unchanged at this point; what's "failing" in the TDD sense is that the OLD file still contains trigger UI these tests no longer exercise. Since this step's test file is a pure subtraction (no new assertions), there's no RED state to observe for new behavior — proceed directly to Step 3, and let Step 4's run confirm nothing broke.

- [ ] **Step 3: Remove the trigger section**

Replace `web/src/components/settings-dialog.tsx` in full with:

```tsx
import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function SettingsDialog({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(fn.name)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const [buildCommand, setBuildCommand] = useState(fn.buildCommand ?? '')
  const update = useUpdateFunction()

  useEffect(() => {
    // Re-seed from `fn` whenever the dialog opens, not just when the `fn`
    // object identity changes. React Query's structural sharing keeps the
    // same `fn` reference across a refetch that changes nothing (e.g. a
    // blank-name save that falls back to the current name), so relying on
    // `fn` alone left a stale, blank Name field the next time the dialog
    // was reopened even though the saved name was correct.
    if (!open) return
    setName(fn.name)
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
    setBuildCommand(fn.buildCommand ?? '')
  }, [open, fn])

  function save() {
    // Empty/garbage input (NaN) keeps the current value; an explicit 0 clamps
    // up to the minimum rather than silently reverting. A blank name keeps
    // the current name by the same rule.
    const t = parseInt(timeoutMs, 10)
    const m = parseInt(memoryMb, 10)
    update.mutate(
      {
        id: fn.id,
        patch: {
          name: name.trim() || fn.name,
          handler: handler.trim(),
          timeoutMs: Math.max(100, Number.isNaN(t) ? fn.timeoutMs : t),
          memoryMb: Math.max(128, Number.isNaN(m) ? fn.memoryMb : m),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
          buildCommand: buildCommand.trim(),
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)}
              spellCheck={false} />
          </div>
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
          <div className="grid gap-2">
            <Label htmlFor="s-build">Build command</Label>
            <Input id="s-build" value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              spellCheck={false} placeholder="e.g. npm run build (empty = none)" />
            <p className="text-xs text-muted-foreground">
              Runs in the project folder before every invoke.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix web run test -- settings-dialog`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings-dialog.tsx web/src/components/settings-dialog.test.tsx
git commit -m "refactor(web): remove trigger configuration from the settings dialog"
```

---

## Task 7: Mount `TriggerButton` in `FunctionHeader`; fix status-badge visibility

**Files:**
- Modify: `web/src/components/function-header.tsx`
- Test: `web/src/components/function-header.test.tsx` (new file — none exists today)

**Interfaces:**
- Consumes: `TriggerButton` (Task 5), `useDetect` (existing hook).

`FunctionHeader` currently decides whether to show the `TriggerStatusBadge` using `fn.trigger?.enabled` alone. A `playground.json`-declared trigger never touches `fn.trigger` (Task 1-3 only affect server-side resolution), so without this fix, a function whose trigger comes entirely from `playground.json` would run (the manager is polling/listening for it) while the UI never shows that it's active. This task fixes that alongside mounting the new button.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/function-header.test.tsx`:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    deleteFunction: vi.fn(), listTriggerStatus: vi.fn(),
    detect: vi.fn(), updateFunction: vi.fn(),
  },
}))

import { FunctionHeader } from '@/components/function-header'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.listTriggerStatus).mockResolvedValue({
    fn1: { state: 'listening', lastError: null, lastPolledAt: null },
  })
  vi.mocked(api.detect).mockResolvedValue({ runtime: 'node', handlerCandidates: [], projectTrigger: null })
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

it('does not show the trigger status badge when neither fn.trigger nor playground.json declares one', async () => {
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  await screen.findByRole('button', { name: 'Configure trigger' })
  expect(screen.queryByText(/Trigger:/)).not.toBeInTheDocument()
})

it('shows the trigger status badge when fn.trigger is enabled', async () => {
  render(<FunctionHeader fn={{ ...fn, trigger: { type: 'http', enabled: true } }} onDeleted={() => {}} />,
    { wrapper: makeWrapper() })
  expect(await screen.findByText('Trigger: listening')).toBeInTheDocument()
})

it('shows the trigger status badge for a playground.json-declared trigger even though fn.trigger is null', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(await screen.findByText('Trigger: listening')).toBeInTheDocument()
})

it('mounts the trigger button', async () => {
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(await screen.findByRole('button', { name: 'Configure trigger' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix web run test -- function-header`
Expected: FAIL — no "Configure trigger" button exists yet, and the third test (playground.json-only trigger) fails because the badge-visibility logic doesn't consider `projectTrigger` yet.

- [ ] **Step 3: Implement**

Replace `web/src/components/function-header.tsx` in full with:

```tsx
import { Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsDialog } from '@/components/settings-dialog'
import { TriggerButton } from '@/components/trigger-button'
import { TriggerStatusBadge } from '@/components/trigger-status-badge'
import { useDeleteFunction, useDetect, useTriggerStatus } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function FunctionHeader({ fn, onDeleted }: { fn: FunctionDef; onDeleted: () => void }) {
  const del = useDeleteFunction()
  const { data: triggerStatuses } = useTriggerStatus()
  // A playground.json-declared trigger never touches fn.trigger, so the
  // status badge's visibility can't rely on fn.trigger?.enabled alone — it
  // needs the same signal TriggerButton uses to decide a trigger is active.
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)
  const triggerActive = projectTrigger != null || fn.trigger?.enabled
  const triggerStatus = triggerActive ? triggerStatuses?.[fn.id] : undefined
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <h2 className="truncate text-sm font-semibold">{fn.name}</h2>
      <Badge variant="secondary" className="font-mono">{fn.runtime}</Badge>
      {triggerStatus && <TriggerStatusBadge status={triggerStatus} />}
      <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
        {fn.handler || 'no handler set'} · {fn.timeoutMs}ms · {fn.memoryMb}MB
      </span>
      <div className="ml-auto flex items-center gap-1">
        <TriggerButton fn={fn} />
        <SettingsDialog fn={fn} />
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
              <AlertDialogAction
                disabled={del.isPending}
                onClick={(e) => {
                  // Keep the dialog open so the pending state stays visible;
                  // the header unmounts on success once the function is gone.
                  e.preventDefault()
                  del.mutate(fn.id, { onSuccess: onDeleted })
                }}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix web run test -- function-header`
Expected: PASS (all 4 tests).

Then run the full web suite (this task touches a shared component many other tests render indirectly):

Run: `npm --prefix web run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/function-header.tsx web/src/components/function-header.test.tsx
git commit -m "feat(web): move the trigger control into the function header"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (`npm run test:server` then `npm run test:web`).

- [ ] **Step 2: Run the web typecheck and build**

Run: `npm --prefix web run typecheck && npm run build`
Expected: both succeed; `npm run build` regenerates `web/dist` so the relocated trigger UI ships.

- [ ] **Step 3: Run the linter**

Run: `npm run lint`
Expected: PASS. Fix anything oxlint flags in the files this plan touched before moving on.

- [ ] **Step 4: Manual smoke test**

Run: `npm start`. In the browser:
1. Register a function with no `playground.json`. Confirm the header shows a "Configure trigger" webhook-icon button (not a Settings-dialog trigger section — open Settings and confirm no trigger UI remains there). Open the trigger picker, set it to HTTP, enable it, save. Confirm the header's trigger status badge appears and the function is reachable at `http://localhost:9500/<name>/...`.
2. In that same function's project folder, add a `playground.json` with `{"trigger": {"type": "http"}}`, then save any change to the function (e.g. reopen Settings and hit Save with no edits) to trigger a re-sync. Confirm the trigger button becomes a read-only "http" label with the "Declared in playground.json" tooltip, and the picker is no longer reachable.
3. Confirm the status badge still shows correctly in this file-declared state.

This step has no automated pass/fail — note in your final report whether you performed it and what you observed.
