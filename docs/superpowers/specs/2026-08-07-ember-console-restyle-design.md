# Ember console restyle

**Date:** 2026-08-07
**Status:** Approved (design conversation), pending spec review

## Goal

Restyle the web UI to match the reference screenshot (Ravion's environment
dashboard): a near-black console with a warm red-maroon undertone, a vivid
orange brand accent, corner-bracket + diagonal-hatch selection states, and
green success ticks. The app's layout and information architecture do not
change — this is a skin, applied through the existing token system.

Both themes stay. Dark is the house look and matches the reference; light is
the same product on warm paper with the identical orange accent, so the
existing theme toggle keeps working.

This replaces the espresso palette from
`2026-07-21-espresso-restyle-design.md`, which demoted amber to a status hue.
Orange returns as *the* brand accent; the espresso spec's structural decisions
(semantic tokens only, `--surface-strip` for section bars, warm-tinted
neutrals, no achromatic gray) all survive.

## Approach

Token retint plus a small signature-detail layer. Rejected alternative: a
component-by-component bespoke restyle chasing the screenshot's layout — that
would copy a different product's information architecture instead of reskinning
ours, for much more churn.

All changes flow through `web/src/styles.css` (token values, two new
utilities) plus targeted class edits in the handful of components that render
active/selected/status states. No markup restructuring, no new dependencies.

## 1. Palette

Hue family moves from espresso brown (hue ~52–84) to ember red-orange
(hue ~35–45). Values below are the intent; exact numbers may be nudged during
implementation for WCAG contrast (body text ≥ 4.5:1, muted ≥ 3:1 against
their backgrounds).

Dark (house look, matches reference):

| Token | Value | Role |
| --- | --- | --- |
| `--background` | `oklch(0.155 0.018 35)` | near-black, red-maroon undertone |
| `--card` / `--popover` | `oklch(0.19 0.022 38)` | panels, one step lighter |
| `--surface-strip` | `oklch(0.235 0.025 40)` | section-header bars |
| `--foreground` | `oklch(0.94 0.012 65)` | warm off-white text |
| `--muted-foreground` | `oklch(0.68 0.03 50)` | timestamps, meta rows |
| `--primary` | `oklch(0.71 0.18 45)` | orange; buttons become orange-on-dark (replaces the cream inverted pill) |
| `--primary-foreground` | `oklch(0.16 0.03 40)` | near-black on orange |
| `--brand` | `oklch(0.72 0.19 45)` | the accent: active tab text, selected borders, links, brackets, hatch |
| `--secondary` / `--muted` | `oklch(0.24 0.022 40)` | quiet fills |
| `--accent` | `oklch(0.27 0.028 42)` | hover fills |
| `--border` / `--input` | warm orange-tinted alpha (~14% / ~18%) | thin panel borders as in reference |
| `--ring` | `oklch(0.71 0.18 45)` | focus moves to orange |
| `--destructive` | unchanged red | errors, diff-removed |
| `--success` (new) | `oklch(0.72 0.17 150)` | ticks, healthy states, diff-added |
| `--success-foreground` (new) | `oklch(0.17 0.03 150)` | text on success fills |

Light (warm paper): same structure re-derived — paper `oklch(0.97 0.012 70)`,
ink `oklch(0.24 0.03 40)`, orange darkened for contrast on light
(`--primary`/`--brand` ≈ `oklch(0.62 0.19 42)`), success darkened similarly.

`--success`/`--success-foreground` are wired into the `@theme inline` block
like every other token so `text-success` etc. exist as utilities. The
palette-rationale comment at the top of `styles.css` is rewritten to describe
this scheme (house rule: comments state what is, not what changed).

## 2. Signature details

Two utilities in `styles.css`, used by components; both read `--brand` so they
work in either theme:

- **`corner-frame`** — the reference's orange corner brackets on the
  selected/live card. One pseudo-element drawing four corner Ls with a
  `background-image` list of eight thin gradient strokes (two per corner),
  positioned/ sized via `background-position`/`background-size`, no extra DOM.
- **`hatch-active`** — 45° diagonal hatching for selected rows:
  `repeating-linear-gradient` of `--brand` at low alpha (~8%) over transparent.

Success ticks are not a utility: components render lucide `CircleCheck` with
`text-success` (filled-look via `fill-success/15` where it reads better).

## 3. Components touched

Selected/active states adopt the language; everything else inherits the new
tokens with zero edits.

- `app-nav.tsx` — active rail item: orange icon on `accent` fill instead of
  the primary pill (an orange square would be too loud at rail size).
- `app-sidebar.tsx` — selected function row: `corner-frame` + `hatch-active` +
  `border-brand/60`; unselected rows keep quiet borders.
- `function-header.tsx` — active tab/segment: `text-brand` with transparent
  background, per the reference's tab bar.
- `history-list.tsx` — each entry gains a `CircleCheck`/`CircleX` status tick
  (success/error) leading the title, meta line (timestamp / trigger) in
  `muted-foreground`, matching the reference's left column cards; selected
  entry gets `hatch-active`.
- `health-chips.tsx`, `service-row.tsx`, `local-service-toggles.tsx` — healthy
  states move from whatever ad-hoc green they use to `text-success`.
- `http-status-badge.tsx` — 2xx `success`, 4xx `brand` (orange), 5xx
  `destructive`.
- CodeMirror chrome (`styles.css`) already inherits tokens; verify selection
  tint still reads with the new `--primary`.

## 4. Error handling / non-goals

- No layout, routing, or behavior changes; props and DOM structure stay so
  component tests keep passing.
- No new dependencies; hatching and brackets are pure CSS.
- The reference's product chrome (breadcrumbs, top tab row, three-pane stack
  browser, JSON diff viewer) is *not* being cloned — only its visual language.
- Not adding a `--warning` token; orange (`brand`) covers the 4xx/warning role
  as amber did before.

## 5. Verification

1. `npm run test:web` — all existing tests stay green (they assert behavior,
   not palette).
2. `npm --prefix web run typecheck`.
3. Live check of both themes in the dev server: sidebar selection, tabs,
   history ticks, service health, buttons, focus rings, CodeMirror, dialogs
   (add-function, settings sheet, command palette) — confirming contrast and
   that no espresso-era hardcoded color survives (grep for `amber`, `emerald`,
   `green-`, `stone-` class remnants).

## Implementation notes

- Spec §3 mentions `hatch-active` on the selected history entry; the shipped
  history list applies none. The list has no persistent selected state —
  clicking an entry swaps to a detail view — so a selection hatch would never
  be visible. The plan and code are correct; this line supersedes §3 on that
  point.
- Sidebar selection ships `border-brand/50` (the plan's value), not §1's
  `border-brand/60`.
