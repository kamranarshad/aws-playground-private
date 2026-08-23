# Per-node copy in JsonTree

`JsonTree` (`web/src/components/json-tree.tsx`) renders every response and
every expanded structured log entry, but the only copy affordance is the
top-right `CopyButton` in `result-panel.tsx:71-76`, which copies the entire
response. There's no way to grab just one field or one subtree without
copying the whole payload and trimming it by hand elsewhere. Add a copy icon
to every row in the tree — leaf and subtree alike — that copies just that
node's value.

## Interaction

Every `Row` (`json-tree.tsx:57-79`) gets an icon-only button in the row's
left gutter, between the toggle chevron (or its spacer) and the field name —
not trailing after the value. Revealed on hover or keyboard focus. Clicking
it copies that row's value and shows the same copied-checkmark confirmation
`useCopy()` already drives for `CopyButton` and `CopyableValue`
(`web/src/lib/use-copy.ts`).

This applies uniformly to every row shape `Node` (`json-tree.tsx:142-174`)
produces: a scalar leaf, an empty container (`{}`/`[]`), and an
expand/collapse subtree row — including one currently showing its collapsed,
embedded-JSON-as-string form. No new prop on `JsonTree` or `Node`; the button
lives inside `Row` itself, so both of `JsonTree`'s current call sites
(`result-panel.tsx:80`, `log-viewer.tsx:136`) get it for free.

## Format

`JSON.stringify(value)` of that node's own value, minified — not re-wrapped
in its key. Copying the `address` subtree yields `{"city":"NYC","zip":
"10001"}`, matching the compact format the whole-response `CopyButton`
already produces (`result-panel.tsx:33-39`, chosen there as "a handoff to
curl, an editor, or a test fixture").

An embedded-JSON string node (`embeddedJson`, `json-tree.tsx:44-55` — API
Gateway's stringified `body`) copies its literal string value, not a
reparsed object, whether the row is open or collapsed. The row always copies
what's actually stored at that node.

A row whose value is `undefined` (a handler that returned nothing; rendered
by `Leaf` as the text `undefined`, `json-tree.tsx:128-129`) gets no copy
button — `JSON.stringify(undefined)` is `undefined`, not a string, so there's
nothing to copy. Compute the button's text up front and skip rendering it
when that's `undefined`, the same guard `result-panel.tsx:37-39` already
applies to the whole-response button.

## Implementation

`Row` gains a required `copy: { value: unknown; label: string }` prop, always
supplied by its two callers in `Node`: the leaf-row return
(`json-tree.tsx:153`) and the toggle-row return (`json-tree.tsx:159-173`).
`label` reuses the same fallback `Node` already computes for the toggle's own
aria-label — `label ?? 'root'` — so a row's copy button and its collapse
button describe the same target the same way. Whether the button actually
renders is decided inside `Row`/`NodeCopyButton` from `copy.value` (the
`undefined`-value guard above), not by the caller.

Inside `Row`, a small `NodeCopyButton` (or inlined `useCopy()` call) renders
between the toggle/spacer and the content div — in the row's gutter, next to
the chevron — rather than the full shadcn `Button` component — `Button`'s
smallest size is `size-8`, visibly taller than a dense JSON row. Sized
`size-3` (`mt-[3px]` top alignment against `leading-6` rows); the chevron
itself is `size-3.5`, so the two gutter icons are close but not pixel-
identical in size. Reveal via `opacity-0` → `group-hover/row:opacity-100` and
`focus-visible:opacity-100`, on a named group (`group/row`) scoped to `Row`
so it doesn't collide with any `group` a parent (log-viewer's row, etc.) may
already use. `aria-label="Copy {label}"`.

## Out of scope

Multi-node selection, a "copy as pretty JSON" toggle, copying a node's
key/value pair instead of just its value, and any change to the existing
whole-response `CopyButton`.

## Testing

`web/src/components/json-tree.test.tsx`, following the clipboard-stub
pattern in `copyable-value.test.tsx`:

- copying a leaf value writes just that value's JSON to the clipboard
- copying a container/subtree row writes that subtree's JSON, independent of
  whether it's expanded or collapsed
- copying a collapsed embedded-JSON-string row writes the raw string, not
  the parsed object
- a row whose value is `undefined` renders no copy button
- Browser: confirm the icon reveals on hover in both the Response tab and an
  expanded Logs-tab row, and that the checkmark confirmation matches the
  existing whole-response copy button's timing.
