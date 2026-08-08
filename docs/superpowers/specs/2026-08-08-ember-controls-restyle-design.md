# Ember controls restyle

**Date:** 2026-08-08
**Status:** Approved (design conversation), pending spec review

## Goal

Extend the ember console language (see
`2026-08-07-ember-console-restyle-design.md`) to the interactive control
primitives — buttons, badges, inputs, selects, dialogs, menus — per the second
reference screenshot (Ravion's module-creation dialog): fully square geometry,
mono-caps button labels, violet CTAs, thin-border mono form fields, and
corner-bracket accents on overlays and open selects.

User decisions locked in conversation: **violet CTAs** (like the reference,
not orange) and **fully square corners** globally.

## 1. Tokens: violet CTA, orange stays the accent

`--primary`/`--primary-foreground` repoint from orange to violet. Everything
that reads `primary` follows: default buttons, checked checkboxes, default
badges. Orange remains `--brand` everywhere it is today: active tabs/nav,
selection brackets + hatch, focus `--ring`, 4xx badges. Division of labor
matches the reference — violet is the call-to-action color, orange is the
selection/focus language.

| Token | Dark | Light |
| --- | --- | --- |
| `--primary` | `oklch(0.75 0.13 295)` (light violet, dark text) | `oklch(0.5 0.19 295)` (deep violet, light text) |
| `--primary-foreground` | `oklch(0.18 0.05 295)` | `oklch(0.985 0.008 70)` |

Values may be nudged during implementation for WCAG (≥ 4.5:1 for button
text). The palette-rationale comment in `styles.css` is updated to describe
the violet CTA role (comments state what is).

CodeMirror's selection tint currently mixes `--primary`; it moves to
`--brand` so text selection stays in the orange selection language rather
than turning violet.

## 2. Geometry: fully square

`--radius: 0rem`. The derived `--radius-sm/md/lg/xl` compute negative and
clamp to 0 at used-value time, so every rounded-* utility flattens with no
component edits. `rounded-full` elements (status dots, spinners) are
unaffected by the token and stay round.

## 3. Buttons and badges

- `button.tsx` base: labels become mono caps — `font-mono text-xs font-medium
  uppercase tracking-wider` (replacing `text-sm font-medium`), matching the
  reference's BACK / CREATE MODULE treatment. Sizes/heights unchanged; icon
  variants render the same.
- `outline` variant: transparent background with a thin `border-input` border
  and no shadow (the reference's "Enable Force destroy"), hover keeps the
  `accent` fill.
- Other variants only change color via the token repoint (default → violet;
  secondary already renders the reference's dark-maroon BACK style).
- `badge.tsx` base: `font-mono uppercase` joins the base class so call sites
  can drop per-use `font-mono` over time (they keep working either way);
  geometry squares via the token.

## 4. Form fields

- `input.tsx`: `font-mono` text; existing thin border + translucent dark fill
  already match the reference's bucket-name field once square.
- `select.tsx`: trigger and items go `font-mono`; the open trigger gains the
  signature brackets — `data-[state=open]:corner-frame` (reference: the open
  "Select…" control).
- CodeMirror editors are already mono and token-driven; no change.

## 5. Overlays

- `dialog.tsx`, `alert-dialog.tsx`, `command.tsx` (palette): content panel
  gains `corner-frame` — the orange corner ticks the reference modal shows.
- `dropdown-menu.tsx`, `sheet.tsx`, tooltips: square + existing dark card
  fill is enough; no bracket accents (reserved for focal surfaces).

## 6. Non-goals

- No layout, DOM, or behavior changes; call sites untouched.
- No new dependencies.
- Not restyling scrollbars, resizable handles, or the sonner toasts beyond
  what the radius token does on its own.

## 7. Verification

1. `npm run test:web` and `npm --prefix web run typecheck` stay green.
2. Live both-theme pass over: every button variant (default/secondary/
   outline/ghost/destructive, icon sizes), add-function dialog, delete
   confirm, settings sheet, command palette, selects (env file picker,
   add-function runtime), inputs, checked checkboxes — checking contrast
   (violet CTA text ≥ 4.5:1) and that mono-caps labels don't truncate or
   wrap in existing layouts.
3. Rebuild `web/dist` at the end so `npm start`/`nub run start` serves the
   result.

## Implementation notes

- §2's claim that all derived radii clamp to 0 is wrong for `--radius-xl`
  (`calc(var(--radius) + 4px)` computes to 4px). No `rounded-xl` consumer
  exists today; if one appears it must use `rounded-none` or the token must
  be revisited.
- `corner-frame`/`hatch-active` are Tailwind `@utility` registrations (not
  plain classes) so state variants like `data-[state=open]:` compose with
  them; `SelectContent` defaults to `position="popper"` so the open trigger
  stays visible. Both supersede §4/§6 where they conflict.
