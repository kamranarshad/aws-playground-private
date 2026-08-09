# Faster Service Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Service containers start when a checkbox is checked and stop within ~1s when unchecked; multi-service selections start in parallel; readiness is detected on a 100ms grid; worst-case stops are bounded at 2s.

**Architecture:** `server/services.js` gains a `stopNow` option on `setSelection`, parallel starts/stops, a tighter readiness poll, and `docker stop -t 2`. `server/api.js` passes `stopNow` through. On the web side the checkbox toggle triggers a selection sync after its PATCH (today it triggers nothing), sending `stopNow: true` on uncheck.

**Tech Stack:** Node core (`node --test`, docker-shim test helpers), React 19 + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-faster-service-lifecycle-design.md`

## Global Constraints

- Manual (user-started) services are never auto-stopped — `stop()` owns the demote/cancel bookkeeping; `stopNow` must only touch services in `autoStarted`.
- Function switching and the unload beacon keep the 15s grace; only the uncheck path sends `stopNow`.
- All commands run from the repo root. Server tests: `npm run test:server`. Web tests: `npm run test:web`. Typecheck: `npm --prefix web run typecheck`.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Comments state what is, never what changed.

---

### Task 1: Server — stopNow, parallel lifecycle, tighter poll, bounded stop (TDD)

**Files:**
- Modify: `server/services.js:189-311` (`waitReady`, `stop`, `setSelection`, `stopAutoStarted`)
- Modify: `server/api.js:193-196` (`selectionOpts`)
- Test: `tests/services.test.js` (additions)

**Interfaces:**
- Consumes: existing docker-shim helpers (`writeDockerShim`, `scenario(map)`, `calls()`) already wired at the top of `tests/services.test.js`.
- Produces: `services.setSelection(needed, { waitReady?, stopNow? })` — new optional `stopNow: boolean`, default false. Return shape unchanged (`{ started, scheduledStop }`). Task 2 relies on the HTTP body field name `stopNow`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/services.test.js` (follow the file's existing `scenario`/`calls` conventions; the shim keys are docker subcommands):

```js
test('stop bounds the docker grace period at 2 seconds', async () => {
  scenario({ stop: { code: 0, stdout: '' } });
  const r = await services.stop('minio');
  assert.strictEqual(r.ok, true);
  assert.ok(calls().some(c => c.startsWith('stop -t 2 aws-playground-minio')),
    `expected a "stop -t 2" call, got: ${calls().join(' | ')}`);
});

test('setSelection starts every needed service', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: '' } });
  const r = await services.setSelection(['minio', 'redis'], { waitReady: false });
  assert.deepStrictEqual([...r.started].sort(), ['minio', 'redis']);
  assert.strictEqual(calls().filter(c => c.startsWith('run')).length, 2);
  await services.setSelection([], { stopNow: true }); // cleanup: no timers left armed
});

test('setSelection stopNow stops a dropped auto service immediately', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: '' } });
  await services.setSelection(['minio'], { waitReady: false });
  const r = await services.setSelection([], { stopNow: true });
  assert.deepStrictEqual(r.scheduledStop, ['minio']);
  assert.ok(calls().some(c => c.startsWith('stop -t 2 aws-playground-minio')),
    'stop must happen inside the call, not on a timer');
  // The service left the auto set when it stopped: a later selection
  // change must not stop it again.
  scenario({ stop: { code: 0, stdout: '' } });
  await services.setSelection([]);
  assert.ok(!calls().some(c => c.startsWith('stop')));
});

test('setSelection without stopNow defers to the grace timer', async () => {
  scenario({ ps: { code: 0, stdout: '' }, run: { code: 0, stdout: 'x' },
    stop: { code: 0, stdout: '' } });
  await services.setSelection(['minio'], { waitReady: false });
  scenario({ stop: { code: 0, stdout: '' } });
  const r = await services.setSelection([]);
  assert.deepStrictEqual(r.scheduledStop, ['minio']);
  assert.ok(!calls().some(c => c.startsWith('stop')),
    'no immediate stop — the grace timer owns it');
  await services.setSelection([], { stopNow: true }); // cleanup: cancels timer, stops
});
```

If the file already has a `setSelection` grace test that conflicts with these
(e.g. asserting an eventual timer-driven stop with a tiny
`AWS_PLAYGROUND_SERVICE_GRACE_MS`), leave it as is — these tests only add the
new paths.

- [ ] **Step 2: Run them to see the new ones fail**

Run: `npm run test:server -- --test-name-pattern="stopNow|bounds the docker|starts every needed|defers to the grace"` — or plain `npm run test:server` and confirm exactly the new tests fail (`stop -t 2` not found; `scheduledStop` differs; immediate stop missing).

- [ ] **Step 3: Implement in `server/services.js`**

`waitReady` (line ~201): change the poll sleep from `400` to `100`.

`stop` (line ~234): change the docker invocation to:

```js
  const r = await docker(['stop', '-t', '2', svc.container], 30000);
```

`setSelection` — replace the whole function with:

```js
async function setSelection(needed, { waitReady: wait = true, stopNow = false } = {}) {
  const need = new Set(needed);
  const started = [];
  const scheduledStop = [];

  for (const name of need) entry(name); // validate before touching docker
  // Cancel pending stops before the first await. Docker can be slow (or hung),
  // and a grace timer coming due mid-probe would otherwise stop a service that
  // has just been selected again.
  for (const name of need) cancelStop(name);
  // One probe for the whole selection instead of one per declared service.
  const states = need.size > 0 ? await statusAll() : null;

  // Independent containers: start them all at once so a multi-service
  // selection costs the slowest boot, not the sum of boots.
  const results = await Promise.all(
    [...need]
      .filter((name) => states?.get(name) !== 'running')
      .map((name) =>
        start(name, { waitReady: wait, auto: true, knownState: states?.get(name) })
          .then((r) => ({ name, r }))),
  );
  for (const { name, r } of results) {
    if (r.ok) {
      autoStarted.add(name);
      started.push(name);
    }
  }

  if (stopNow) {
    // An explicit uncheck means "stop it now" — no grace. stop() owns the
    // bookkeeping: it removes the service from autoStarted and cancels any
    // pending timer, so a later selection change cannot double-stop it.
    const dropped = [...autoStarted].filter((name) => !need.has(name));
    scheduledStop.push(...dropped);
    await Promise.all(dropped.map((name) => stop(name).catch(() => {})));
  } else {
    for (const name of [...autoStarted]) {
      if (need.has(name) || stopTimers.has(name)) continue;
      scheduledStop.push(name);
      stopTimers.set(name, setTimeout(() => {
        stopTimers.delete(name);
        // Re-check membership: a manual start/stop may have promoted or
        // cleared it while the timer was pending.
        if (!autoStarted.has(name)) return;
        autoStarted.delete(name);
        stop(name).catch(() => {});
      }, graceMs()));
    }
  }

  return { started, scheduledStop };
}
```

`stopAutoStarted` — replace the sequential loop with a parallel one:

```js
async function stopAutoStarted() {
  const pending = [...autoStarted];
  for (const name of pending) cancelStop(name);
  autoStarted.clear();
  const results = await Promise.all(pending.map((name) =>
    stop(name).then((r) => ({ name, ok: r.ok }), () => ({ name, ok: false }))));
  return results.filter((r) => r.ok).map((r) => r.name);
}
```

In `server/api.js`, replace `selectionOpts` with:

```js
function selectionOpts(input) {
  const opts = {};
  // waitReady:false is a test affordance; the UI never sends it.
  if (input?.waitReady === false) opts.waitReady = false;
  if (input?.stopNow === true) opts.stopNow = true;
  return opts;
}
```

- [ ] **Step 4: Run the server suite**

Run: `npm run test:server`
Expected: all pass, including the four new tests (169 + 4 = 173).

- [ ] **Step 5: Commit**

```bash
git add server/services.js server/api.js tests/services.test.js
git commit -m "perf(services): stopNow unchecks, parallel lifecycle, 100ms ready poll, stop -t 2"
```

---

### Task 2: Web — the toggle syncs the selection (TDD)

**Files:**
- Create: `web/src/components/local-service-toggles.test.tsx`
- Modify: `web/src/lib/api.ts:47-50` (`setSelection` signature)
- Modify: `web/src/lib/queries.ts:109-116` (`useSelectionSync` input)
- Modify: `web/src/routes/index.tsx:42` (call-site shape)
- Modify: `web/src/components/local-service-toggles.tsx` (sync after PATCH)

**Interfaces:**
- Consumes: server body field `stopNow` (Task 1); `useUpdateFunction`, `useServices`, `useDetect` as already imported by the toggles component.
- Produces: `api.setSelection(functionId, opts?: { stopNow?: boolean })`; `useSelectionSync().mutate({ functionId, stopNow? })`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/local-service-toggles.test.tsx`:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { detect: vi.fn(), listServices: vi.fn(), updateFunction: vi.fn(), setSelection: vi.fn() },
}))

import { LocalServiceToggles } from '@/components/local-service-toggles'
import { api } from '@/lib/api'
import type { Detection, FunctionDef, ServicesStatus } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
}

const detection: Detection = {
  runtime: 'node', handlerCandidates: [], envFiles: [], projectServices: null,
}

const services: ServicesStatus = {
  docker: { available: true },
  services: [{
    name: 'minio', label: 'S3 (MinIO)', shortLabel: 'S3', note: null,
    state: 'stopped', endpoint: 'http://127.0.0.1:9400', consoleUrl: null, credentials: [],
  }],
}

beforeEach(() => {
  vi.mocked(api.detect).mockResolvedValue(detection)
  vi.mocked(api.listServices).mockResolvedValue(services)
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
  vi.mocked(api.setSelection).mockResolvedValue({ started: [], scheduledStop: [] })
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

it('checking a service records it and syncs the selection to start it', async () => {
  const user = userEvent.setup()
  render(<LocalServiceToggles fn={fn} />, { wrapper: makeWrapper() })
  await user.click(await screen.findByRole('checkbox', { name: 'S3' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ localServices: ['minio'] }))
  await waitFor(() => expect(api.setSelection).toHaveBeenCalledWith('fn1', {}))
})

it('unchecking syncs with stopNow so the container stops immediately', async () => {
  const user = userEvent.setup()
  render(<LocalServiceToggles fn={{ ...fn, localServices: ['minio'] }} />,
    { wrapper: makeWrapper() })
  await user.click(await screen.findByRole('checkbox', { name: 'S3' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ localServices: [] }))
  await waitFor(() =>
    expect(api.setSelection).toHaveBeenCalledWith('fn1', { stopNow: true }))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:web -- local-service-toggles`
Expected: FAIL — `api.setSelection` is never called (and the two-arg shape doesn't exist yet).

- [ ] **Step 3: Implement**

`web/src/lib/api.ts` — replace `setSelection` with:

```ts
  setSelection: (functionId: string | null, opts: { stopNow?: boolean } = {}) =>
    request<{ started: string[]; scheduledStop: string[] }>('/api/selection', {
      method: 'POST', body: JSON.stringify({ functionId, ...opts }),
    }),
```

`web/src/lib/queries.ts` — `useSelectionSync`'s mutationFn becomes:

```ts
    mutationFn: ({ functionId, stopNow }: { functionId: string | null; stopNow?: boolean }) =>
      api.setSelection(functionId, stopNow ? { stopNow } : {}),
```

`web/src/routes/index.tsx:42` — the sync effect call becomes:

```ts
    syncSelection({ functionId: selectedId })
```

`web/src/components/local-service-toggles.tsx` — import `useSelectionSync`
alongside the existing query imports, instantiate it next to `update`, and
replace `toggle` with:

```tsx
  const selectionSync = useSelectionSync()
  function toggle(name: string, on: boolean) {
    update.mutate(
      {
        id: fn.id,
        patch: {
          localServices: on ? [...enabled, name] : enabled.filter((s) => s !== name),
        },
      },
      {
        // The PATCH only records the choice; the selection sync is what
        // starts a newly checked service and (stopNow) stops an unchecked
        // one without waiting out the grace timer.
        onSuccess: () => selectionSync.mutate({ functionId: fn.id, stopNow: !on }),
      },
    )
  }
```

Note the check path sends `stopNow: false`, which the mutationFn drops — the
wire shape is `{}` exactly as the first test asserts.

- [ ] **Step 4: Run the gate**

Run: `npm run test:web && npm --prefix web run typecheck`
Expected: 149 web tests (147 + 2), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/local-service-toggles.test.tsx web/src/components/local-service-toggles.tsx web/src/lib/api.ts web/src/lib/queries.ts web/src/routes/index.tsx
git commit -m "feat(web): service checkbox starts/stops its container via selection sync"
```

---

### Task 3: Live verification and dist rebuild

**Files:**
- Possibly modify: none expected
- Verify: live behavior against real docker; rebuild `web/dist`

- [ ] **Step 1: Live check**

Run `npm run dev`; with the `browse` skill, on a function without a
`playground.json` services declaration:
- check S3 (MinIO): checkbox settles and `docker ps` shows the container running within ~1–2s; an invoke does not report "S3 (MinIO) is not running"
- uncheck it: time from click until `docker ps` shows the container exited — must be under ~2s (was: never, until a selection change plus 15s)
- switch to another function and back with the box checked: the service keeps running (grace preserved on selection changes)
- manually start a service from the services page, uncheck nothing — it stays running (manual services untouched)
Kill the dev server. Leave docker as you found it (stop anything you started via the UI's own paths).

- [ ] **Step 2: Full gate + rebuild**

Run: `npm test && npm --prefix web run typecheck && npm run build`
Expected: all suites green; `web/dist` rebuilt.

- [ ] **Step 3: Commit (only if the live check forced a source fix)**

```bash
git add <specific files>
git commit -m "fix(web): <what the live check surfaced>"
```

---

## Self-Review Notes

- Spec §1 (poll) → Task 1 Step 3. §2 (parallel) → Task 1 (setSelection + stopAutoStarted). §3 (toggle sync + stopNow) → Tasks 1–2. §4 (`-t 2`) → Task 1. Spec Verification → Task 3.
- The spec's api.test.js item is covered instead by the services-level tests plus the web test asserting the wire shape; `selectionOpts` is a three-line passthrough reviewed directly. If `tests/api.test.js` already has `/api/selection` coverage, the implementer may extend it with a `stopNow` passthrough case, but it is not required for green.
- Type consistency: `setSelection(needed, { waitReady, stopNow })` server-side; `api.setSelection(functionId, { stopNow? })` web-side; `useSelectionSync` input `{ functionId, stopNow? }` — Task 2's index.tsx and toggles snippets both use that shape.
- Test-count expectations: server 169 → 173; web 147 → 149.
