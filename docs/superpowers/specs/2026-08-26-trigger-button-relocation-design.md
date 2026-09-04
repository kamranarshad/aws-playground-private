# Trigger button relocation + playground.json-declared triggers

**Date:** 2026-08-26
**Status:** Approved (design conversation), pending spec review

## Goal

Move trigger configuration (SQS/HTTP, added in the previous HTTP-trigger
feature) out of the Settings dialog and into its own dedicated control in
the function header, and let a project's `playground.json` declare a
trigger the same way it already declares local services — a file-governed
config that overrides manual per-function configuration and is shown
read-only in the UI when present.

## Scope decisions (from brainstorming)

- Trigger configuration moves out of the Settings dialog entirely — not
  duplicated, relocated. Settings reverts to its pre-HTTP-trigger shape
  (name, handler, timeout, memory, jar path, build command); the trigger
  UI (type selector, queue name input, HTTP URL preview) becomes its own
  component.
- New button lives in `FunctionHeader`, on the right, grouped with
  `SettingsDialog` and the delete button — an active "go configure this"
  control, distinct from the existing `TriggerStatusBadge` on the left,
  which stays exactly where it is as the passive "here's what's running"
  indicator.
- `playground.json` gains an optional `trigger` key, parsed the same way
  `services` already is (re-read fresh, not cached, never validated
  against the registry at write time). Presence in the file means
  enabled — no separate on/off flag, matching how a service listed in
  `playground.json`'s `services` array has no independent enabled toggle.
- When `playground.json` declares a trigger for a function, that
  configuration **overrides** whatever is manually stored on the function
  (`fn.trigger` in `functions.json`) — identical precedence to
  `effectiveServices`. The UI reflects this by showing a read-only label
  instead of the interactive button, exactly the treatment
  `LocalServiceToggles` already gives a `playground.json`-declared
  service list.
- No live file-watching. A `playground.json` trigger declaration is
  picked up at the same points `manager.sync(fn)` already runs today:
  function create, function update (any field, not just trigger-related
  ones), and server startup (`resumeAll`). A hand-edit to the file for an
  already-registered, otherwise-untouched function takes effect on the
  next update to that function or the next server restart — not
  instantly. This is a real, stated limitation, not an oversight.

## Data model

`server/projectconfig.js`'s `read(dir)` gains a second field:

```js
// { services: string[] | null, trigger: { type: 'sqs', queueName: string } | { type: 'http' } | null }
```

Parsing rules for `trigger`, applied the same defensive way `services`
already is (malformed → `null`, never throws):
- Missing key, or not an object → `trigger: null`.
- `type` must be `'sqs'` or `'http'`; anything else → `trigger: null`.
- `type: 'sqs'` requires a non-empty string `queueName` → otherwise
  `trigger: null`.
- `type: 'http'` takes no other fields (routing is by the function's
  `name` in `functions.json`, which `playground.json` has no say over).
- Unlike manually-configured triggers, a `playground.json` trigger has no
  `enabled` field — presence *is* enabled, matching `services`.

New `effectiveTrigger(fn)` helper, placed alongside the existing
`effectiveServices(fn)` in `server/api/services.js` (or split into a
small sibling module if that file's getting crowded — implementer's call
at plan-writing time):

```js
function effectiveTrigger(fn) {
  return projectconfig.read(fn.path).trigger ?? fn.trigger ?? null;
}
```

## Server wiring

`server/trigger/manager.js`'s `sync(fn)` currently branches on
`fn.trigger` directly (`fn.trigger?.type`, `fn.trigger.enabled`, etc.).
It's changed to compute the effective trigger first:

```js
async function sync(fn) {
  const trigger = effectiveTrigger(fn); // was: const trigger = fn.trigger;
  // ...unchanged from here — the rest of sync()'s branching logic doesn't change.
}
```

A `playground.json`-declared trigger has no `enabled` field, so every
`trigger.enabled` check in `sync()` (`!trigger.enabled` guards) needs to
treat a `playground.json`-sourced trigger as always enabled. Cleanest
fix: `effectiveTrigger` normalizes the shape it returns —
`projectconfig.read(fn.path).trigger` results get `enabled: true` stamped
on before returning, so every downstream consumer keeps working against
one consistent shape (`{type, enabled, queueName?}`) regardless of source.

`server/detect.js` gains a `projectTrigger` field on its response,
computed identically to the existing `projectServices` field:

```js
projectTrigger: projectconfig.read(dir).trigger,
```

No change to `server/api/functions.js`'s validation — a manually-set
`fn.trigger` (the only thing that endpoint ever writes) is validated
exactly as it is today. `playground.json` triggers are never written
through the API, so they're never subject to that validation; a
malformed one simply parses to `null` per the rules above and the
function behaves as if no trigger were configured, the same graceful
degradation `services` already has.

## Web UI

**Settings dialog** (`web/src/components/settings-dialog.tsx`): the
entire trigger section — type `Select`, SQS queue name input, HTTP URL
preview, both `Checkbox`es, all associated state
(`triggerType`/`triggerQueueName`/`triggerEnabled`) and the `trigger`
branch of `save()`'s patch — is removed. The component reverts to what
it was before the HTTP-trigger feature, with `HTTP_TRIGGER_PORT` moving
to wherever the new trigger UI lives.

**New `TriggerButton` component**
(`web/src/components/trigger-button.tsx`), mounted in
`FunctionHeader` on the right, next to `SettingsDialog`:

```tsx
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

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Configure trigger">
          <Webhook className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        {/* the None/SQS/HTTP type selector, queue name input, and HTTP URL
            preview — moved verbatim from settings-dialog.tsx's current
            trigger section, same fields, same save() shape */}
      </DialogContent>
    </Dialog>
  )
}
```

Icon: `Webhook` from `lucide-react` (already a dependency; matches the
concept more directly than reusing `Settings2`).

`FunctionHeader`'s existing `TriggerStatusBadge` usage is untouched —
both it and the new button read from independent queries
(`useTriggerStatus()` for the badge, `useDetect(...projectTrigger)` for
the button) and can be visible at the same time: badge shows *what's
running*, button shows *how to change it* (or, read-only, *why you
can't*).

`web/src/lib/types.ts`'s `Detection` interface gains
`projectTrigger?: FunctionTrigger | null` alongside the existing
`projectServices?: string[] | null`.

## Testing

- `server/projectconfig.js`: parsing tests for `trigger` — valid sqs,
  valid http, missing key, malformed type, sqs without queueName, all
  asserting `trigger: null` on the invalid cases (mirrors the existing
  `services` parsing tests' structure).
- `server/trigger/manager.js`: `effectiveTrigger` wins over `fn.trigger`
  when `playground.json` declares one; falls back to `fn.trigger` when
  it doesn't; a `playground.json` trigger is treated as always-enabled
  with no `enabled` field present on the parsed value.
- `server/detect.js`: `projectTrigger` reflects `playground.json`'s
  declared trigger the same way `projectServices` already does.
- Web: new `trigger-button.test.tsx` covering both states (interactive
  picker when no file declaration; read-only label with the tooltip text
  when one exists) — largely the same test cases Task 7 wrote for
  `settings-dialog.test.tsx`'s trigger section, relocated and extended
  with the read-only-state case. `settings-dialog.test.tsx` loses its
  trigger-related tests (`'seeds the trigger fields...'`,
  `'saves the trigger config...'`, `'clears the trigger...'`, the HTTP
  equivalents from Task 7) since that code moved.

## Non-goals

- Live file-watching / instant pickup of a `playground.json` edit for an
  otherwise-untouched, already-registered function (documented limitation
  above, not a gap to close later without being asked).
- Any change to trigger *validation* rules (name uniqueness, `/`-in-name,
  malformed-response handling, etc.) — this feature only changes where
  configuration comes from and where the control lives, not what's valid.
- `playground.json`-declared *services* behavior — unchanged, this only
  adds the analogous `trigger` key alongside the existing `services` key.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`.
