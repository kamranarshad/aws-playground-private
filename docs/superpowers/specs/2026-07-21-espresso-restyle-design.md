# Espresso restyle (Empirical-reference visual language)

Restyle the playground to the warm dark dashboard aesthetic of the
reference screenshot: espresso surfaces, cream text and primary,
mono uppercase labels, section-strip headers, filled status chips.
No behavior, layout, or feature changes; all tests stay green.

## Tokens (`web/src/styles.css`)

- Dark (default): background near-black warm espresso; card/popover
  warm brown a step lighter; a `--surface-strip` tone another step
  lighter for section headers; borders cream at ~10%; foreground warm
  cream; muted-foreground warm gray. Primary = cream with espresso
  primary-foreground (inverted pills). Destructive = filled warm red.
  Success/2xx = green; warning/4xx amber (status only — no amber
  brand accent anymore).
- Light: warm cream paper background, near-white cream cards,
  espresso foreground; primary = espresso with cream foreground; same
  status hues. The two themes read as one product.
- `--radius: 0.625rem`. Mono font stack unchanged.
- CM6 `.cm-host` overrides re-tuned to the new surface tokens.

## Theme default

Dark is the default when no stored preference exists (stored
preference always wins). Both the pre-hydration script in
`__root.tsx` and `ThemeProvider` change from matchMedia-fallback to
dark-fallback.

## Component treatments (class-level only)

- Sidebar: mono uppercase tracked group label (FUNCTIONS); active
  item = filled cream pill with espresso text; hover = subtle warm
  wash; runtime badges outline/subdued.
- Header: λ mark cream; health chips subdued warm; ⌘K kbd hint and
  theme toggle unchanged structurally.
- Section strips: env-vars collapsible header and the results-tab
  header row sit on `--surface-strip` with rounded corners, like the
  reference's "Overview" / "Build and Runner Info" strips.
- Labels: ENVIRONMENT VARIABLES, FUNCTIONS, the function-header
  metadata line, and the history "N runs" line use mono uppercase
  tracked-wide styling where they don't already.
- Buttons: Invoke = primary (cream), destructive stays red; ghost
  buttons get warm hover.
- Status chips: OK/ERR and HTTP badges become filled tinted chips
  (green/red/amber/sky at ~15% fills with matching text), matching
  the reference's Failed chip weight.

## Verification

- `npm --prefix web run typecheck` + build clean; full root suite
  (95) green — no behavior changes.
- Headless-browser pass in BOTH themes: shell, invoke flow, history,
  dialogs, palette; screenshots captured dark and light; console
  clean.

## Out of scope

Layout or navigation changes, new components, light/dark-specific
feature differences, editing the reference's sidebar sections into
the app (the playground keeps its single FUNCTIONS group).
