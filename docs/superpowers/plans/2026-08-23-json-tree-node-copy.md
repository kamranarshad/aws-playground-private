# Per-Node Copy in JsonTree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover-reveal copy icon to every row of `JsonTree` so a single field or subtree can be copied without grabbing the whole response.

**Architecture:** `Row` (the shared per-line layout primitive in `json-tree.tsx`) gains a required `copy` prop carrying that row's raw value and display label. `Row` renders a small icon-only button after its content, using the existing `useCopy()` hook. `Node`'s three return sites (leaf, empty container, toggle/subtree) each pass their own `value`/`label` through. No new exports, no new props on `JsonTree` itself — both existing consumers (`result-panel.tsx`, `log-viewer.tsx`) get the feature automatically.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (already in place for this component).

**Spec:** `docs/superpowers/specs/2026-08-23-json-tree-node-copy-design.md`

## Global Constraints

- Copy format is minified `JSON.stringify(value)` of the row's own value — never re-wrapped in its key.
- A row whose value stringifies to `undefined` (only reachable case: a bare `undefined` root) renders no copy button at all.
- An embedded-JSON-string row (`embeddedJson()`) always copies its literal string value, never the reparsed object, regardless of open/collapsed state.
- Button label is `Copy {label}`, where `label` is the exact same `label ?? 'root'` fallback the toggle row already computes for its own `aria-label`.
- Icon sized to the row (`size-3`, `mt-[3px]` top alignment) — do not use the shared `Button` component (its smallest size is `size-8`, taller than the `leading-6` row).
- Reveal on hover *or* keyboard focus (`opacity-0` → `group-hover/row:opacity-100` / `focus-visible:opacity-100`), on a `Row`-scoped named group (`group/row`) so it can't collide with a `group` a parent component uses.

---

### Task 1: Per-node copy button in JsonTree

**Files:**
- Modify: `web/src/components/json-tree.tsx`
- Test: `web/src/components/json-tree.test.tsx`

**Interfaces:**
- Consumes: `useCopy()` from `web/src/lib/use-copy.ts` — existing hook, `{ copied: boolean; copy: (value: string) => Promise<void> }`. `Check`, `Copy` icons from `lucide-react` (package already a dependency — `ChevronRight` is imported from it in this same file today).
- Produces: nothing new is exported. `JsonTree`'s public signature (`{ value: unknown; className?: string }`) is unchanged, so `result-panel.tsx` and `log-viewer.tsx` need no changes.

- [ ] **Step 1: Write the failing tests**

Replace the top of `web/src/components/json-tree.test.tsx` (the current lines 1–5) with:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { JsonTree } from '@/components/json-tree'

function stubClipboard() {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  })
  return writeText
}

afterEach(() => vi.clearAllMocks())
```

(This mirrors the exact pattern already used in `web/src/components/result-panel.test.tsx:1-18` for its own `CopyButton` test.)

Then append these four tests at the end of the file, after the existing `'formats a stack trace on real line breaks when its row is expanded'` test:

```tsx
it('copies a leaf value as its own JSON, not the whole response', async () => {
  const writeText = stubClipboard()
  render(<JsonTree value={{ statusCode: 200, body: 'hi' }} />)

  await userEvent.click(screen.getByLabelText('Copy statusCode'))

  expect(writeText).toHaveBeenCalledWith('200')
})

it('copies a subtree independent of its expand state', async () => {
  const writeText = stubClipboard()
  const headers = { 'content-type': 'application/json' }
  render(<JsonTree value={{ headers }} />)

  await userEvent.click(screen.getByLabelText('Copy headers'))
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(headers))

  await userEvent.click(screen.getByLabelText('Collapse headers'))
  await userEvent.click(screen.getByLabelText('Copy headers'))
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(headers))
})

it('copies a collapsed embedded-JSON string as the raw string, not the parsed object', async () => {
  const writeText = stubClipboard()
  const raw = '{"userId":7}'
  render(<JsonTree value={{ body: raw }} />)

  await userEvent.click(screen.getByLabelText('Collapse body'))
  await userEvent.click(screen.getByLabelText('Copy body'))

  expect(writeText).toHaveBeenCalledWith(JSON.stringify(raw))
})

// A handler that returned nothing has no JSON to copy: JSON.stringify(undefined)
// is undefined, not a string.
it('renders no copy button for an undefined value', () => {
  render(<JsonTree value={undefined} />)

  expect(screen.queryByLabelText('Copy root')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix web run test -- json-tree`
Expected: the four new tests FAIL (`getByLabelText('Copy statusCode')` etc. find nothing — no copy button exists yet). All pre-existing tests in this file still PASS.

- [ ] **Step 3: Add the imports and the `NodeCopyButton` component**

In `web/src/components/json-tree.tsx`, replace the top import block:

```tsx
import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
```

with:

```tsx
import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCopy } from '@/lib/use-copy'
```

Then, immediately before the existing `Row` function, add:

```tsx
function NodeCopyButton({ value, label }: { value: unknown; label: string }) {
  const { copied, copy } = useCopy()
  const text = JSON.stringify(value)
  if (text === undefined) return null

  return (
    <button
      type="button" onClick={() => copy(text)} aria-label={`Copy ${label}`}
      className="mt-[3px] shrink-0 rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  )
}
```

- [ ] **Step 4: Wire the button into `Row`**

Replace the existing `Row` function:

```tsx
function Row({ toggle, children }: {
  toggle?: { open: boolean; label: string; onClick: () => void }
  children: ReactNode
}) {
  // The gap sits on the row, not the chevron, so leaf rows (which fill the
  // chevron column with a spacer) keep the same text origin.
  return (
    <div className="flex items-start gap-1.5">
      {toggle
        ? (
          <button
            type="button" onClick={toggle.onClick} aria-expanded={toggle.open}
            aria-label={`${toggle.open ? 'Collapse' : 'Expand'} ${toggle.label}`}
            className="mt-[3px] shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', toggle.open && 'rotate-90')} />
          </button>
        )
        : <span className="w-3.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 break-all">{children}</div>
    </div>
  )
}
```

with:

```tsx
function Row({ toggle, copy, children }: {
  toggle?: { open: boolean; label: string; onClick: () => void }
  copy: { value: unknown; label: string }
  children: ReactNode
}) {
  // The gap sits on the row, not the chevron, so leaf rows (which fill the
  // chevron column with a spacer) keep the same text origin.
  return (
    <div className="group/row flex items-start gap-1.5">
      {toggle
        ? (
          <button
            type="button" onClick={toggle.onClick} aria-expanded={toggle.open}
            aria-label={`${toggle.open ? 'Collapse' : 'Expand'} ${toggle.label}`}
            className="mt-[3px] shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', toggle.open && 'rotate-90')} />
          </button>
        )
        : <span className="w-3.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 break-all">{children}</div>
      <NodeCopyButton value={copy.value} label={copy.label} />
    </div>
  )
}
```

- [ ] **Step 5: Pass `copy` from all three `Node` return sites**

Replace the body of `Node` (currently):

```tsx
  const branch = kids ?? embedded
  if (!branch) return <Row><Key label={label} index={index} /><Leaf value={value} /></Row>

  if (kids && !kids.entries.length) {
    return <Row><Key label={label} index={index} /><Punct>{kids.summary}</Punct></Row>
  }

  return (
    <>
      <Row toggle={{ open, label: label ?? 'root', onClick: () => setOpen(!open) }}>
        <Key label={label} index={index} />
        {!open && embedded
          // Collapsed, an embedded subtree goes back to being the string it is.
          ? <Leaf value={value} />
          : <Punct>{branch.summary}</Punct>}
        {open && embedded && (
          <span className="ml-2 text-[10px] text-muted-foreground/80 italic">parsed from string</span>
        )}
      </Row>
      {open && <Branch kids={branch} depth={depth} />}
    </>
  )
```

with:

```tsx
  const copy = { value, label: label ?? 'root' }

  const branch = kids ?? embedded
  if (!branch) return <Row copy={copy}><Key label={label} index={index} /><Leaf value={value} /></Row>

  if (kids && !kids.entries.length) {
    return <Row copy={copy}><Key label={label} index={index} /><Punct>{kids.summary}</Punct></Row>
  }

  return (
    <>
      <Row toggle={{ open, label: label ?? 'root', onClick: () => setOpen(!open) }} copy={copy}>
        <Key label={label} index={index} />
        {!open && embedded
          // Collapsed, an embedded subtree goes back to being the string it is.
          ? <Leaf value={value} />
          : <Punct>{branch.summary}</Punct>}
        {open && embedded && (
          <span className="ml-2 text-[10px] text-muted-foreground/80 italic">parsed from string</span>
        )}
      </Row>
      {open && <Branch kids={branch} depth={depth} />}
    </>
  )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix web run test -- json-tree`
Expected: PASS, all tests in the file (the four new ones plus every pre-existing one).

- [ ] **Step 7: Typecheck and run the full web suite**

Run: `npm --prefix web run typecheck`
Expected: no errors.

Run: `npm run test:web`
Expected: PASS, all test files (this confirms `result-panel.test.tsx` and `log-viewer.test.tsx` — both of which render `JsonTree` — still pass unchanged, since `Copy {label}` never collides with either file's own `Collapse root` / `Expand log entry` labels).

- [ ] **Step 8: Manual check in the browser**

Run: `npm run dev`, invoke any fixture, open the Response tab.
Confirm:
- Hovering a leaf row (e.g. a top-level key) reveals a copy icon at the end of the row; clicking it shows the checkmark confirmation and the value lands on the clipboard.
- Hovering a container row (an object/array with a chevron) reveals its own copy icon; clicking it copies the whole subtree as compact JSON.
- Tabbing to a row with the keyboard also reveals its copy icon (not hover-only).
- Open the Logs tab, expand a structured log row with attributes, confirm the same per-row copy icons appear there too.
- Confirm the existing top-right "Copy response JSON" button (unrelated to this change) still works and still copies the whole response.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/json-tree.tsx web/src/components/json-tree.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add per-node copy to the JSON tree

Every row (leaf or subtree) now has a hover-reveal copy icon that
copies just that node's value, so a single field can be grabbed
without copying the whole response and trimming it by hand.
EOF
)"
```
