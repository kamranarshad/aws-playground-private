# Settings Dialog with Editable Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the function name editable in settings, and convert the settings surface from a slide-in sheet to a centered modal dialog.

**Architecture:** Frontend-only — the server PATCH already accepts `name`. `settings-sheet.tsx` becomes `settings-dialog.tsx` using the `Dialog*` primitives (which already carry the ember treatment); a Name field joins the form with the form's forgiving blank-keeps-current rule; `function-header.tsx` (only call site) updates its import.

**Tech Stack:** React 19, TanStack Query, shadcn/ui Dialog, vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-08-09-settings-dialog-rename-design.md`

## Global Constraints

- Frontend only: no server, store, type, or API-layer changes.
- All commands run from the repo root. Web tests: `npm run test:web`. Typecheck: `npm --prefix web run typecheck`.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Comments state what is, never what changed.

---

### Task 1: SettingsDialog with editable name (TDD)

**Files:**
- Create: `web/src/components/settings-dialog.test.tsx`
- Rename: `web/src/components/settings-sheet.tsx` → `web/src/components/settings-dialog.tsx` (via `git mv`, then rewrite)
- Modify: `web/src/components/function-header.tsx:9,23`

**Interfaces:**
- Consumes: `useUpdateFunction` (`mutate({ id, patch })` → `api.updateFunction(id, patch)`), `Dialog*` primitives from `@/components/ui/dialog`.
- Produces: `SettingsDialog({ fn }: { fn: FunctionDef })` — same prop shape `SettingsSheet` had.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/settings-dialog.test.tsx`:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn() },
}))

import { SettingsDialog } from '@/components/settings-dialog'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function openSettings() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Function settings' }))
  return user
}

it('opens as a modal showing the current name', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  await openSettings()
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveValue('test')
})

it('saves the trimmed name through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.type(input, '  renamed  ')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ name: 'renamed' }))
})

it('keeps the current name when the field is left blank', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1',
    expect.objectContaining({ name: 'test' }))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:web -- settings-dialog`
Expected: FAIL — `@/components/settings-dialog` does not exist.

- [ ] **Step 3: Rename and rewrite the component**

```bash
git mv web/src/components/settings-sheet.tsx web/src/components/settings-dialog.tsx
```

Then replace the file's contents with:

```tsx
import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function SettingsDialog({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(fn.name)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const [buildCommand, setBuildCommand] = useState(fn.buildCommand ?? '')
  const update = useUpdateFunction()

  useEffect(() => {
    setName(fn.name)
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
    setBuildCommand(fn.buildCommand ?? '')
  }, [fn])

  function save() {
    // Empty/garbage input (NaN) keeps the current value; an explicit 0 clamps
    // up to the minimum rather than silently reverting. A blank name keeps
    // the current name by the same rule.
    const t = parseInt(timeoutMs, 10)
    const m = parseInt(memoryMb, 10)
    update.mutate(
      {
        id: fn.id,
        patch: {
          name: name.trim() || fn.name,
          handler: handler.trim(),
          timeoutMs: Math.max(100, Number.isNaN(t) ? fn.timeoutMs : t),
          memoryMb: Math.max(128, Number.isNaN(m) ? fn.memoryMb : m),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
          buildCommand: buildCommand.trim(),
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-handler">Handler</Label>
            <Input id="s-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-timeout">Timeout (ms)</Label>
            <Input id="s-timeout" type="number" min={100} step={1000} value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-memory">Memory (MB)</Label>
            <Input id="s-memory" type="number" min={128} step={64} value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)} />
          </div>
          {fn.runtime === 'java' && (
            <div className="grid gap-2">
              <Label htmlFor="s-jar">Jar path</Label>
              <Input id="s-jar" value={jarPath} onChange={(e) => setJarPath(e.target.value)}
                spellCheck={false} placeholder="auto-detected if empty" />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="s-build">Build command</Label>
            <Input id="s-build" value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              spellCheck={false} placeholder="e.g. npm run build (empty = none)" />
            <p className="text-xs text-muted-foreground">
              Runs in the project folder before every invoke.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

(Differences from the sheet version, for the reviewer: `Sheet*` → `Dialog*`; the
form wrapper drops `px-4` because `DialogContent` already pads with `p-6`; the
Name field is new; everything else is unchanged.)

In `web/src/components/function-header.tsx`, change the import
`import { SettingsSheet } from '@/components/settings-sheet'` to
`import { SettingsDialog } from '@/components/settings-dialog'` and the usage
`<SettingsSheet fn={fn} />` to `<SettingsDialog fn={fn} />`.

- [ ] **Step 4: Run the new tests, then the full gate**

Run: `npm run test:web -- settings-dialog`
Expected: 3/3 pass.
Run: `npm run test:web && npm --prefix web run typecheck`
Expected: full suite green (146 web tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings-dialog.tsx web/src/components/settings-dialog.test.tsx web/src/components/function-header.tsx
git commit -m "feat(web): editable function name in settings, sheet becomes modal"
```

(The `git mv` stages the deletion of `settings-sheet.tsx` automatically; confirm
`git status` shows no leftover `settings-sheet.tsx` before committing.)

---

### Task 2: Visual verify and dist rebuild

**Files:**
- Possibly modify: none expected
- Verify: both themes live; rebuild `web/dist`

- [ ] **Step 1: Visual pass**

Run `npm run dev`; with the `browse` skill check dark then light:
- settings opens as a centered modal with the ember dialog treatment (square, corner brackets, close button)
- renaming a function propagates to the sidebar row, header title, and dialog title after Save
- blank name → Save keeps the old name; dialog closes on success
- the Java-only Jar path field still appears for a java function if one exists (skip if none registered)
Kill the dev server when done.

- [ ] **Step 2: Rebuild dist**

Run: `npm run build`
Expected: build completes so `npm start`/`nub run start` serves the change. Nothing to commit (`web/dist` is gitignored) unless the visual pass required a source fix — if it did, commit that fix with a conventional message.

---

## Self-Review Notes

- Spec design bullets 1–3 → Task 1; spec Verification → Task 2.
- Test count: 143 existing + 3 new = 146 expected in Task 1 Step 4.
- `useUpdateFunction` signature confirmed against `web/src/lib/queries.ts:56-60` (`mutate({ id, patch })` → `api.updateFunction(id, patch)`); the mock asserts on `(id, patch)` accordingly.
- The Save button's accessible name stays "Save" — the mono-caps rendering is CSS `uppercase`, which does not change the accessible name.
