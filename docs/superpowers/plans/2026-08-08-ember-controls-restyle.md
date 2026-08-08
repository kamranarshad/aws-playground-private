# Ember Controls Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the ember language to control primitives: violet CTAs, fully square geometry, mono-caps buttons, mono form fields, corner-bracket accents on open selects and modal panels.

**Architecture:** Token changes in `web/src/styles.css` (violet `--primary`, `--radius: 0`), then class edits confined to the shadcn primitives in `web/src/components/ui/` — call sites untouched. `corner-frame` and `--brand` (orange) already exist from the previous restyle.

**Tech Stack:** Tailwind CSS 4, shadcn/ui, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-ember-controls-restyle-design.md`

## Global Constraints

- No new dependencies; no DOM restructuring; call sites unchanged.
- Orange (`--brand`, `--ring`) remains the selection/focus language; violet is only `--primary` (CTAs, checked checkboxes, default badges).
- All commands run from the repo root. Web tests: `npm run test:web`. Typecheck: `npm --prefix web run typecheck`.
- Commit messages use conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Comments state what is, never what changed.

---

### Task 1: Tokens — violet primary, square radius, selection tint to brand

**Files:**
- Modify: `web/src/styles.css` (both token blocks, palette comment, CodeMirror selection rule)

**Interfaces:**
- Produces: violet `--primary`/`--primary-foreground` in both themes; `--radius: 0rem`. Later tasks rely on `rounded-*` utilities flattening via the token and on `corner-frame` (already present).

- [ ] **Step 1: Update both token blocks**

In `:root`, change these three lines (values only; all other tokens stay):

```css
  --radius: 0rem;
  --primary: oklch(0.5 0.19 295);
  --primary-foreground: oklch(0.985 0.008 70);
```

In `.dark`, change these two lines:

```css
  --primary: oklch(0.75 0.13 295);
  --primary-foreground: oklch(0.18 0.05 295);
```

- [ ] **Step 2: Update the palette-rationale comment**

In the comment block at the top, replace the sentence describing `--brand`/`--primary` so the comment describes the split (keep the rest of the comment intact). The relevant sentence currently says orange (`--brand`, `--primary`) is the accent; it becomes:

```
  off-white text, vivid orange (--brand) as the accent for active states,
  selected borders, and focus, and violet (--primary) as the call-to-action
  color for buttons, checked controls, and default badges. --success is the
```

- [ ] **Step 3: Move CodeMirror selection tint from primary to brand**

In the `.cm-host .cm-selectionBackground` rule, change:

```css
  background: color-mix(in oklab, var(--primary) 22%, transparent) !important;
```

to:

```css
  background: color-mix(in oklab, var(--brand) 22%, transparent) !important;
```

- [ ] **Step 4: Verify**

Run: `npm run test:web && npm --prefix web run typecheck`
Expected: 143/143 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css
git commit -m "restyle(web): violet CTA tokens, square radius, brand selection tint"
```

---

### Task 2: Button and badge primitives — mono caps, flat outline, square badge

**Files:**
- Modify: `web/src/components/ui/button.tsx:8,16-17`
- Modify: `web/src/components/ui/badge.tsx:8`

**Interfaces:**
- Consumes: nothing new.
- Produces: same exported components; no signature changes.

- [ ] **Step 1: Mono-caps button base**

In `button.tsx`, in the cva base string, replace the fragment `rounded-md text-sm font-medium` with:

```
rounded-md font-mono text-xs font-medium uppercase tracking-wider
```

(Keep `rounded-md` — it flattens to 0 via the token; removing it would churn every size variant.)

- [ ] **Step 2: Flat outline variant**

Replace the `outline` variant string with:

```ts
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent",
```

- [ ] **Step 3: Square, mono badge**

In `badge.tsx`, in the cva base string, replace `rounded-full` with `rounded-none` and replace `text-xs font-medium` with `font-mono text-xs font-medium uppercase`.

(The spec assumed the token would square badges; `rounded-full` is hardcoded, so this explicit change supersedes that line of the spec.)

- [ ] **Step 4: Verify**

Run: `npm run test:web`
Expected: all pass — no test asserts button/badge classes; visual call sites unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/button.tsx web/src/components/ui/badge.tsx
git commit -m "restyle(web): mono-caps buttons, flat outline variant, square mono badges"
```

---

### Task 3: Form fields — mono input and select, brackets on open select

**Files:**
- Modify: `web/src/components/ui/input.tsx:11`
- Modify: `web/src/components/ui/select.tsx:39-41` (trigger) and the `SelectContent` class (~line 64)

**Interfaces:**
- Consumes: `corner-frame` utility (exists in `styles.css`).
- Produces: same exported components.

- [ ] **Step 1: Mono, flat input with brand selection**

In `input.tsx`'s first class string, make exactly these three edits:
- insert `font-mono` immediately before `text-base`
- remove `shadow-xs`
- replace `selection:bg-primary selection:text-primary-foreground` with `selection:bg-brand/30 selection:text-foreground`

- [ ] **Step 2: Mono select trigger with open-state brackets**

In `select.tsx`'s `SelectTrigger` class string:
- insert `font-mono` immediately before `text-sm`
- remove `shadow-xs`
- append `data-[state=open]:corner-frame` at the end of the string (before the closing quote)

- [ ] **Step 3: Mono select content**

In the `SelectContent` class string (the one containing `bg-popover text-popover-foreground` at ~line 64), insert `font-mono text-sm` after `bg-popover text-popover-foreground`.

- [ ] **Step 4: Verify**

Run: `npm run test:web`
Expected: all pass (env-editor tests exercise inputs by role/value, not classes).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/input.tsx web/src/components/ui/select.tsx
git commit -m "restyle(web): mono form fields, corner brackets on open select"
```

---

### Task 4: Overlay accents, visual pass, dist rebuild

**Files:**
- Modify: `web/src/components/ui/dialog.tsx:62`
- Modify: `web/src/components/ui/alert-dialog.tsx` (content class)
- Possibly modify: `web/src/styles.css` (contrast nudges only, same hue families)
- Verify: both themes live; rebuild `web/dist`

**Interfaces:**
- Consumes: `corner-frame`.
- Note: the command palette renders through `CommandDialog` → `DialogContent`, so it inherits the dialog's brackets — do NOT also add `corner-frame` to `command.tsx` (double brackets). This supersedes the spec's listing of `command.tsx` as a file to edit.

- [ ] **Step 1: Dialog and alert-dialog corner brackets**

In `dialog.tsx`'s `DialogContent` class string and `alert-dialog.tsx`'s `AlertDialogContent` class string, insert `corner-frame` immediately after `z-50` in each.

- [ ] **Step 2: Full gate**

Run: `npm run test:web && npm --prefix web run typecheck`
Expected: green.

- [ ] **Step 3: Visual pass, both themes**

Run `npm run dev`; with a headless browser (the `browse` skill) check dark then light:
- every button variant: default (violet, readable ≥ 4.5:1), secondary, outline (thin border, transparent), ghost, destructive, icon sizes — labels in mono caps, no truncation/wrap in headers (sidebar "ADD", history "CLEAR"/"BACK"/"LOAD EVENT", invoke button)
- add-function dialog + delete confirm + command palette (⌘K): square, corner brackets, single set only on the palette
- selects (env file picker, add-function runtime): mono text, brackets while open
- inputs: mono, flat, orange selection highlight when text selected
- checked checkboxes: violet
- badges: square mono caps everywhere (runtime chips, status pills)
- CodeMirror: selection now orange-tinted
Fix only objective breakage (contrast < 4.5:1 for button text, layout overflow) by nudging token values in `styles.css` within the same hue family; note anything subjective as a concern instead.

- [ ] **Step 4: Rebuild dist**

Run: `npm run build`
Expected: vite build completes; `web/dist` fresh so `npm start`/`nub run start` serves the new controls.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/dialog.tsx web/src/components/ui/alert-dialog.tsx web/src/styles.css
git commit -m "restyle(web): corner brackets on modal panels, controls visual pass"
```

(`web/dist` is gitignored — nothing else to add.)

---

## Self-Review Notes

- Spec §1 → Task 1 (tokens + comment + CM selection). §2 → Task 1 radius. §3 → Task 2. §4 → Task 3. §5 → Task 4 (command.tsx deliberately dropped — inherits via CommandDialog; noted inline). §7 → Tasks 1–4 verify steps + Task 4 dist rebuild.
- Badge `rounded-full` reality supersedes the spec's token assumption; handled explicitly in Task 2 Step 3.
- No type/signature changes anywhere; all edits are class strings and token values.
