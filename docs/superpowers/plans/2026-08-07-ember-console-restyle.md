# Ember Console Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the web UI to the Ravion-style ember look — near-black red-maroon dark theme, vivid orange brand accent, corner-bracket + hatch selection states, green success ticks — via the existing token system.

**Architecture:** All color flows through semantic tokens in `web/src/styles.css`; this plan changes token values, adds two CSS utilities (`corner-frame`, `hatch-active`) and a `--success` token, then converts the handful of components with hardcoded status colors or selected/active states. No layout, routing, or behavior changes.

**Tech Stack:** Tailwind CSS 4 (`@theme inline` tokens), shadcn/ui components, React 19, vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-08-07-ember-console-restyle-design.md`

## Global Constraints

- No new dependencies; brackets and hatching are pure CSS.
- No DOM restructuring beyond what a task shows — component tests must keep passing.
- Both themes stay; every new color reads a token (`--brand`, `--success`, `--destructive`) so it adapts. The only allowed literal Tailwind palette color after this plan is `sky-*` (3xx badges, JSON numbers), which the spec leaves alone.
- Comments follow house style: describe what is, never what changed.
- All commands run from the repo root. Web tests: `npm run test:web`. Typecheck: `npm --prefix web run typecheck`.
- Commit messages use conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Retint the palette (tokens + `--success`)

**Files:**
- Modify: `web/src/styles.css:6-95` (header comment, `:root`, `.dark`, `@theme inline`)

**Interfaces:**
- Produces: CSS custom properties `--success` and `--success-foreground` plus Tailwind utilities `text-success`, `bg-success`, `border-success` (etc.) via `--color-success` / `--color-success-foreground`. All later tasks rely on `text-brand`, `bg-brand`, `text-success`, `bg-success` existing.

- [ ] **Step 1: Replace the palette-rationale comment and both token blocks**

Replace the comment block at lines 6–14 with:

```css
/*
  Ember console palette.
  Every neutral carries a warm red-orange tint (oklch hue ~35–70, low chroma)
  so the console reads as a deliberate ember surface, never default
  achromatic gray. Dark is the house look: near-black red-maroon background,
  warm dark panels, a lighter --surface-strip for section-header bars, warm
  off-white text, and vivid orange (--brand, --primary) as the accent for
  active states, selected borders, and focus. --success is the green for
  ticks and healthy states; red stays on --destructive. Light is the same
  product on warm paper with the identical orange accent.
*/
```

Replace the whole `:root` block with:

```css
:root {
  --radius: 0.625rem;
  --background: oklch(0.97 0.012 70);
  --foreground: oklch(0.24 0.03 40);
  --card: oklch(0.985 0.008 70);
  --card-foreground: oklch(0.24 0.03 40);
  --popover: oklch(0.985 0.008 70);
  --popover-foreground: oklch(0.24 0.03 40);
  --surface-strip: oklch(0.93 0.018 65);
  --primary: oklch(0.62 0.19 42);
  --primary-foreground: oklch(0.985 0.008 70);
  --secondary: oklch(0.925 0.015 65);
  --secondary-foreground: oklch(0.26 0.03 40);
  --muted: oklch(0.925 0.015 65);
  --muted-foreground: oklch(0.47 0.03 45);
  --accent: oklch(0.9 0.02 60);
  --accent-foreground: oklch(0.26 0.03 40);
  --destructive: oklch(0.575 0.218 26);
  --destructive-foreground: oklch(0.985 0.006 84);
  --border: oklch(0.86 0.025 60);
  --input: oklch(0.86 0.025 60);
  --ring: oklch(0.62 0.19 42);
  --brand: oklch(0.63 0.19 42);
  --brand-foreground: oklch(0.985 0.008 70);
  --success: oklch(0.55 0.15 150);
  --success-foreground: oklch(0.98 0.01 150);
}
```

Replace the whole `.dark` block with:

```css
.dark {
  --background: oklch(0.155 0.018 35);
  --foreground: oklch(0.94 0.012 65);
  --card: oklch(0.19 0.022 38);
  --card-foreground: oklch(0.94 0.012 65);
  --popover: oklch(0.19 0.022 38);
  --popover-foreground: oklch(0.94 0.012 65);
  --surface-strip: oklch(0.235 0.025 40);
  --primary: oklch(0.71 0.18 45);
  --primary-foreground: oklch(0.16 0.03 40);
  --secondary: oklch(0.24 0.022 40);
  --secondary-foreground: oklch(0.94 0.012 65);
  --muted: oklch(0.24 0.022 40);
  --muted-foreground: oklch(0.68 0.03 50);
  --accent: oklch(0.27 0.028 42);
  --accent-foreground: oklch(0.96 0.012 65);
  --destructive: oklch(0.585 0.203 25);
  --destructive-foreground: oklch(0.97 0.012 83);
  --border: oklch(0.75 0.06 50 / 14%);
  --input: oklch(0.75 0.06 50 / 18%);
  --ring: oklch(0.71 0.18 45);
  --brand: oklch(0.72 0.19 45);
  --brand-foreground: oklch(0.16 0.03 40);
  --success: oklch(0.72 0.17 150);
  --success-foreground: oklch(0.17 0.03 150);
}
```

- [ ] **Step 2: Wire the success tokens into `@theme inline`**

After the `--color-brand-foreground` line inside `@theme inline`, add:

```css
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
```

- [ ] **Step 3: Verify tests and typecheck still pass**

Run: `npm run test:web && npm --prefix web run typecheck`
Expected: all 143 web tests pass, typecheck clean. (Token values aren't asserted anywhere; this catches CSS syntax errors via vite.)

- [ ] **Step 4: Commit**

```bash
git add web/src/styles.css
git commit -m "restyle(web): ember palette — red-black dark, orange brand, success token"
```

---

### Task 2: Signature utilities + sidebar selection

**Files:**
- Modify: `web/src/styles.css` (append after the `@layer base` block, before the CodeMirror section)
- Modify: `web/src/components/app-sidebar.tsx:28-47`

**Interfaces:**
- Consumes: `--brand` token (Task 1).
- Produces: CSS classes `corner-frame` and `hatch-active`, reused by Task 4 (history rows use `hatch-active` only). Both are plain classes usable in any `className`.

- [ ] **Step 1: Add the utilities to `styles.css`**

Insert after the `@layer base { ... }` block:

```css
/*
  Selection language: the active card is framed by four orange corner
  brackets (one pseudo-element, eight gradient strokes — a horizontal and a
  vertical per corner) over a low-alpha 45° hatch fill. Both read --brand so
  they hold up in either theme.
*/
.corner-frame {
  position: relative;
}
.corner-frame::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  --corner-stroke: color-mix(in oklab, var(--brand) 90%, transparent);
  background-image:
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke)),
    linear-gradient(var(--corner-stroke), var(--corner-stroke));
  background-repeat: no-repeat;
  background-size:
    10px 1.5px, 1.5px 10px,
    10px 1.5px, 1.5px 10px,
    10px 1.5px, 1.5px 10px,
    10px 1.5px, 1.5px 10px;
  background-position:
    top left, top left,
    top right, top right,
    bottom left, bottom left,
    bottom right, bottom right;
}
.hatch-active {
  background-image: repeating-linear-gradient(
    45deg,
    color-mix(in oklab, var(--brand) 10%, transparent) 0 1px,
    transparent 1px 7px
  );
}
```

- [ ] **Step 2: Restyle the selected function row in `app-sidebar.tsx`**

The selected row drops the solid primary pill for the reference's framed card. Corner brackets need square corners, so rows go `rounded-none`. Replace the `<button>` and `<Badge>` (lines 28–46) with:

```tsx
<button
  onClick={() => onSelect(fn.id)}
  className={cn(
    'flex w-full items-center justify-between gap-2 rounded-none border px-2.5 py-1.5 text-left text-sm transition-colors',
    fn.id === selectedId
      ? 'corner-frame hatch-active border-brand/50 bg-brand/5 font-medium text-foreground'
      : 'border-transparent text-foreground hover:bg-accent',
  )}
>
  <span className="truncate">{fn.name}</span>
  <Badge
    variant="outline"
    className={cn(
      'shrink-0 font-mono text-[10px]',
      fn.id === selectedId && 'border-brand/40 text-brand',
    )}
  >
    {fn.runtime}
  </Badge>
</button>
```

- [ ] **Step 3: Verify tests pass**

Run: `npm run test:web`
Expected: all pass (no test asserts sidebar classes).

- [ ] **Step 4: Commit**

```bash
git add web/src/styles.css web/src/components/app-sidebar.tsx
git commit -m "restyle(web): corner-bracket + hatch selection, applied to sidebar"
```

---

### Task 3: Convert hardcoded status colors to tokens

**Files:**
- Modify: `web/src/lib/http.ts:12-17`
- Modify: `web/src/components/history-list.tsx:11`
- Modify: `web/src/components/result-panel.tsx:51`
- Modify: `web/src/components/copy-button.tsx:21`
- Modify: `web/src/components/copyable-value.tsx:15`
- Modify: `web/src/components/json-tree.tsx:99`
- Modify: `web/src/components/log-viewer.tsx:10-11,20-21,80`
- Modify: `web/src/components/service-row.tsx:11-12`
- Test: `web/src/components/log-viewer.test.tsx:159`

**Interfaces:**
- Consumes: `text-success`/`bg-success` utilities (Task 1), `text-brand`/`bg-brand` (existing token, retinted in Task 1).
- Produces: nothing new — same exported names (`httpStatusClass`, components) with token-based classes.

- [ ] **Step 1: Update the log-viewer test to expect the token class**

In `web/src/components/log-viewer.test.tsx` line 159, change:

```ts
expect(meta.querySelector('.text-emerald-700')).toHaveTextContent('"str"')
```

to:

```ts
expect(meta.querySelector('.text-success')).toHaveTextContent('"str"')
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:web -- log-viewer`
Expected: FAIL — `.text-success` matches nothing yet.

- [ ] **Step 3: Convert the colors**

`web/src/lib/http.ts` — replace `httpStatusClass`:

```ts
export function httpStatusClass(status: number): string {
  if (status < 300) return 'border-transparent bg-success/15 text-success'
  if (status < 400) return 'border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400'
  if (status < 500) return 'border-transparent bg-brand/15 text-brand'
  return 'border-transparent bg-destructive/15 text-destructive'
}
```

`web/src/components/history-list.tsx` line 11:

```ts
const OK_CHIP = 'border-transparent bg-success/15 text-success'
```

`web/src/components/result-panel.tsx` line 51 — the ok-chip conditional becomes:

```ts
result.ok && 'border-transparent bg-success/15 text-success',
```

`web/src/components/copy-button.tsx` line 21 and `web/src/components/copyable-value.tsx` line 15: `text-emerald-500` → `text-success`.

`web/src/components/json-tree.tsx` line 99:

```ts
if (typeof value === 'string') return 'text-success'
```

`web/src/components/log-viewer.tsx` — in the level color maps, `error: 'text-red-600 dark:text-red-400'` → `error: 'text-destructive'`, `warn: 'text-amber-600 dark:text-amber-400'` → `warn: 'text-brand'`; in the dot map, `error: 'bg-red-500'` → `error: 'bg-destructive'`, `warn: 'bg-amber-500'` → `warn: 'bg-brand'`; line 80 `bg-red-500/5` → `bg-destructive/5`.

`web/src/components/service-row.tsx` — in `STATE_DOT`: `running: 'bg-emerald-500'` → `running: 'bg-success'`, `stopped: 'bg-amber-500'` → `stopped: 'bg-brand'`.

- [ ] **Step 4: Run the full web suite**

Run: `npm run test:web`
Expected: all pass, including the updated log-viewer test.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/http.ts web/src/components/history-list.tsx web/src/components/result-panel.tsx web/src/components/copy-button.tsx web/src/components/copyable-value.tsx web/src/components/json-tree.tsx web/src/components/log-viewer.tsx web/src/components/service-row.tsx web/src/components/log-viewer.test.tsx
git commit -m "restyle(web): status colors read success/brand/destructive tokens"
```

---

### Task 4: Active states — nav rail, tabs, history ticks

**Files:**
- Modify: `web/src/components/app-nav.tsx:36-39`
- Modify: `web/src/components/result-panel.tsx:38-42`
- Modify: `web/src/components/history-list.tsx:79-96` (list rows only; the open-entry header keeps its badge because it shows the error type)

**Interfaces:**
- Consumes: `text-brand` (Task 1), `hatch-active` (Task 2), `text-success` (Task 1), `OK_CHIP` and `HttpStatusBadge` as already used in `history-list.tsx`.
- Produces: nothing new — same component exports.

- [ ] **Step 1: Orange active state on the nav rail**

In `web/src/components/app-nav.tsx`, the active branch of the `cn(...)` (currently `'bg-primary text-primary-foreground'`) becomes:

```ts
active
  ? 'bg-accent text-brand'
  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
```

- [ ] **Step 2: Orange active tab in `result-panel.tsx`**

Above the component, add a shared class for the reference's flat orange active tab:

```ts
// Reference look: the active tab is orange text on a flat background — no
// pill, no shadow — so all state lives in the text color.
const TAB =
  'text-xs data-[state=active]:bg-transparent data-[state=active]:text-brand data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent'
```

Replace `className="text-xs"` with `className={TAB}` on all four `TabsTrigger`s (`response`, `logs`, `report`, `history`).

- [ ] **Step 3: Status ticks on history rows**

In `web/src/components/history-list.tsx`: add `CircleCheck, CircleX` to the lucide import, then in the list `<button>` (lines 81–94) replace the leading `<Badge>` with a tick — the badge is redundant next to it in the row; the HTTP badge stays:

```tsx
<button
  className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs hover:bg-accent"
  onClick={() => setOpenEntry(e)}
>
  {e.ok
    ? <CircleCheck className="size-3.5 shrink-0 text-success" />
    : <CircleX className="size-3.5 shrink-0 text-destructive" />}
  {e.ok && <HttpStatusBadge response={e.response} prefix={false} />}
  <span className="truncate font-mono">{e.handler}</span>
  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
    {e.durationMs ?? '?'}ms · {age(e.ts)}
  </span>
</button>
```

If the now-unused `Badge` import (or `OK_CHIP`) is only referenced by the open-entry header, leave them — the header still uses both.

- [ ] **Step 4: Run the full web suite**

Run: `npm run test:web`
Expected: all pass. `result-panel.test.tsx` exercises tab behavior via roles/labels, not classes; history rows keep their accessible structure.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/app-nav.tsx web/src/components/result-panel.tsx web/src/components/history-list.tsx
git commit -m "restyle(web): orange active nav/tabs, success ticks on history rows"
```

---

### Task 5: Sweep, verify, visual check

**Files:**
- Possibly modify: any file the sweep grep flags
- Verify: both themes in the dev server

- [ ] **Step 1: Sweep for espresso-era literals**

Run: `grep -rn "emerald\|amber-\|green-[0-9]\|red-[0-9]\|stone-" web/src --include="*.tsx" --include="*.ts" | grep -v test`
Expected: no hits. If any remain (e.g. in `event-panel.tsx`, `add-function-dialog.tsx`), convert them with the same mapping as Task 3 — success-green → `success`, warning-amber → `brand`, error-red → `destructive` — and rerun until clean. `sky-*` hits are allowed (Global Constraints).

- [ ] **Step 2: Full gate**

Run: `npm run test:web && npm --prefix web run typecheck`
Expected: 143+ tests pass (count grows if Task 3's test edit split any), typecheck clean.

- [ ] **Step 3: Visual check, both themes**

Run: `npm run dev` (web dev server, serves the API too). In the browser check dark then light via the theme toggle:

- sidebar: selected function shows orange corner brackets + hatch; unselected rows quiet
- nav rail: active item orange icon on subtle fill
- tabs: active tab orange text, no pill
- history: green ticks on ok runs, red on errors
- result panel: OK chip green, HTTP badges (2xx green / 4xx orange / 5xx red)
- services page: running dot green, stopped dot orange
- CodeMirror: selection tint readable with orange `--primary`, gutter border visible
- dialogs (add function, settings sheet, command palette): readable contrast, orange focus rings
- no unreadable text anywhere (muted-on-dark is the usual suspect)

Fix anything off by nudging the token values in `styles.css` (stay within the spec's hue family; keep body text ≥ 4.5:1 contrast).

- [ ] **Step 4: Final commit (if the sweep or visual pass changed files)**

```bash
git add -A web/src
git commit -m "restyle(web): sweep remaining palette literals, contrast nudges"
```

---

## Self-Review Notes

- Spec §1 palette → Task 1. Spec §2 utilities → Task 2. Spec §3 component list → Tasks 2–4 plus the Task 5 sweep (health-chips has no hardcoded green today — it uses secondary/outline badges — so it needed no task; the sweep still guards it). Spec §5 verification → Task 5.
- The spec's "function-header tabs" actually live in `result-panel.tsx` (the function header has no tabs); Task 4 targets the real file.
- Type consistency: no new exports anywhere; `httpStatusClass` keeps its signature; `TAB` is file-local.
