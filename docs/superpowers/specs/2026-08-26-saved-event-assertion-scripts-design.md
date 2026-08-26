# Saved event assertion scripts

**Date:** 2026-08-26
**Status:** Approved (design conversation), pending spec review

## Goal

Replace the single "expected status" field on a saved event (added
earlier on this branch, not yet released) with a small Jest-flavored
assertion script: a saved event can carry a few lines of JS using an
`expect(...).toBe/toEqual/toContain/toMatch(...)` API, run on demand
against the last invoke result, reporting every assertion's pass/fail
rather than stopping at the first failure. This stays a lightweight
regression check, not a test framework: one script per saved event, no
suites, no async, no auto-run on invoke.

## Scope decisions (from brainstorming)

- **Runs in the browser**, not the server. The data already available to
  `ResultPanel` (`response`, `error`, `report`) is enough for status/body/
  header-shaped checks, and this is a local dev tool where the user
  already runs their own arbitrary handler code — no sandboxing beyond
  what `new Function` already gives for free.
- **`expect()` never throws.** Real Jest throws on the first failed
  matcher, aborting the rest of the test. Here, every `expect()` call
  records its own pass/fail and execution continues, so a single script
  with several assertions reports a full checklist in one run instead of
  making you fix-and-rerun one failure at a time.
- **Four matchers only**: `toBe`, `toEqual`, `toContain`, `toMatch`. No
  `.not`, no numeric comparisons, no custom matchers — extendable later
  if needed, not preemptively built.
- **Replaces `expectedStatus` entirely**, not alongside it.
  `expectedStatus?: number` never shipped past this branch, so there's no
  migration concern — `SavedEvent` gets one assertion mechanism
  (`assertionScript?: string`), not two.
- **Script editor is CodeMirror with JS syntax highlighting**
  (`@codemirror/lang-javascript`, a new dependency), matching the
  existing JSON event editor's polish rather than a plain `<textarea>`.
- **Checks run only on explicit button press**, never automatically after
  an invoke. The button lives in `EventPanel`'s toolbar (with Save/
  Invoke), not in `ResultPanel`. This decouples "ran the handler" from
  "checked the result" — you can invoke once, then run checks against
  that same result as many times as you want (e.g. after only editing
  the script), and old check results are cleared (not silently
  re-validated) whenever the response or the active script changes out
  from under them.

## Data model

`web/src/lib/types.ts`:

```ts
export interface SavedEvent {
  name: string
  event: unknown
  assertionScript?: string // was: expectedStatus?: number
}

export interface CheckResult {
  matcher: 'toBe' | 'toEqual' | 'toContain' | 'toMatch'
  actual: unknown
  expected: unknown
  pass: boolean
}
```

`server/store.js` persists `savedEvents` opaquely already (`ALLOWED_KEYS`
patch-through, no per-field validation) — no server change needed, same
as the field it replaces.

## Script engine

New pure module, `web/src/lib/assertions.ts`:

```ts
export function runAssertions(
  script: string,
  ctx: { response: unknown; error: LambdaError | null | undefined; report: Report | null },
): { results: CheckResult[]; scriptError: string | null }
```

Behavior:
- Builds `expect(actual)` as a closure over a local `results: CheckResult[]`
  array. Each matcher method (`toBe`, `toEqual`, `toContain`, `toMatch`)
  evaluates its condition, pushes `{ matcher, actual, expected, pass }`,
  and returns `undefined` — no chaining beyond one matcher call per
  `expect()`, no return value to act on.
- `toBe`: `actual === expected`.
- `toEqual`: recursive deep-equality (small hand-rolled `deepEqual`
  helper — no new dependency for this; NaN-safe, key-order-independent).
- `toContain`: `actual.includes(expected)` when `actual` is a string or
  array; `pass: false` with a descriptive `expected` value
  (`'toContain requires a string or array'`) otherwise — never throws.
- `toMatch`: `expected` is a `RegExp`, or a string compiled with
  `new RegExp(expected)`; tests against `String(actual)`.
- Runs the script via
  `new Function('response', 'error', 'report', 'expect', script)`,
  invoked with `ctx.response`, `ctx.error`, `ctx.report`, and the local
  `expect`. Wrapped in `try/catch`: a thrown error (syntax error from the
  `new Function` call itself, or a runtime error mid-script) is caught,
  and `scriptError` is set to its message. `results` accumulated *before*
  the throw are still returned — a bug three lines into a five-line
  script still reports the first two assertions.
- No timeout/interruption handling — same trust model as the handler
  invoke this tool already runs locally.

## Web UI

**Save dialog** (`web/src/components/event-panel.tsx`): the "Expected
status" number `Input` is replaced by a CodeMirror instance
(`@codemirror/lang-javascript`, same `useTheme()`-driven theme as the
event JSON editor), sized for a handful of lines, with placeholder
content `expect(response.statusCode).toBe(200)`. Empty content saves the
event with no `assertionScript`, same as leaving the old field blank.

`onLoadSavedEvent` (already wired for the status-code feature) is
unchanged in shape — it hands back the whole `SavedEvent`, so
`assertionScript` rides along automatically; only the type of the field
it exposes changes.

**"Run checks" button** (`web/src/components/event-panel.tsx`): a new
button in the toolbar, disabled unless the active saved event has a
non-empty `assertionScript` *and* an invoke result exists. `EventPanel`
gains two new props to support this — `canRunChecks: boolean` and
`onRunChecks: () => void` — computed and owned by `routes/index.tsx`,
which is the one place that already holds both `activeAssertion` and
`result`.

**Results — `ResultPanel`'s "Checks" tab**
(`web/src/components/result-panel.tsx`): a new tab, shown next to
Response/Logs/Report only when `checkResults` is non-null (mirrors the
existing conditional History tab). Renders:
- One row per `CheckResult`: `✓`/`✗`, matcher name, expected value,
  actual value on failure (e.g. `✓ toBe(200)` / `✗ toContain("ok") —
  actual: "hi"`).
- A `scriptError` row at the end if present, styled as a failure, showing
  the thrown message.
- A summary chip in the header row (same slot the old expected-status
  chip occupied): `"3/4 passed"` in the success color when all pass,
  destructive color otherwise; absent when `checkResults` is null.

`ResultPanel` gains a `checkResults: { results: CheckResult[]; scriptError: string | null } | null`
prop, passed a `checksTab`-style slot the same way `historyTab` works
today — or, since this content is simple enough to not need its own
component, rendered inline the same way the Report tab is today
(implementer's call at plan-writing time).

**State — `routes/index.tsx`**: new `checkResults` state alongside
`result` and `activeAssertion`. Cleared (set to `null`) whenever:
`result` changes (a new invoke happened), `activeAssertion` changes
(different saved event loaded, template picked, or hand-edit), or the
selected function changes. Set only inside the `onRunChecks` handler,
which calls `runAssertions(activeAssertion.assertionScript, { response: result.response, error: result.error, report: result.report })`.
Note `onRunChecks` is only reachable when `canRunChecks` is true, so
`activeAssertion.assertionScript` and `result.ok` fields are always
present by the time it runs — no additional null-guarding needed beyond
what TypeScript already requires. When `result.ok` is `false` (invoke
errored), `response` is `undefined` — the script still runs and any
`expect(response...)` line naturally fails since `response` is
`undefined`, rather than the check being pre-emptively skipped.

## Testing

- `web/src/lib/assertions.test.ts` (new): each matcher's pass/fail case,
  `toContain`/`toMatch` type-mismatch fallbacks, a script that throws
  partway through (asserts partial `results` plus `scriptError`), a
  script with a syntax error, an empty script (`results: []`,
  `scriptError: null`).
- `event-panel.test.tsx`: save dialog persists `assertionScript` instead
  of `expectedStatus` (replaces the two tests written for the status-code
  version); "Run checks" button disabled/enabled states; clicking it
  calls `onRunChecks`.
- `result-panel.test.tsx`: Checks tab renders rows for a passed/mixed
  `checkResults`; summary chip text and color; tab and chip both absent
  when `checkResults` is null; `scriptError` row rendering (replaces the
  status-badge tests written for the status-code version).

## Non-goals

- Multiple scripts per saved event, or scripts that run against
  something other than the single most recent invoke result.
- Auto-running checks after invoke — explicit button press only, by
  request.
- `.not`, numeric comparison matchers, or custom/user-defined matchers —
  the four listed matchers are the whole v1 surface.
- Any server-side change — `savedEvents` continues to persist opaquely
  through the existing patch-through in `server/store.js`.
- Migrating/preserving old `expectedStatus` values — the field never
  shipped past this branch.

## Verification

`npm run test:web` (or `vitest run` in `web/`), web typecheck
(`tsc --noEmit`), `oxlint --react-plugin .`.
