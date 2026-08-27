import { expect, it, vi } from 'vitest'
import { validateSearch } from '@/routes/index'

it('keeps a string function name from the URL', () => {
  expect(validateSearch({ function: 's3-handler' })).toEqual({ function: 's3-handler', tab: undefined })
})

it('drops a non-string function value', () => {
  expect(validateSearch({ function: 42 })).toEqual({ function: undefined, tab: undefined })
})

it('keeps a recognized tab value', () => {
  expect(validateSearch({ tab: 'logs' })).toEqual({ function: undefined, tab: 'logs' })
})

it('drops an unrecognized tab value', () => {
  expect(validateSearch({ tab: 'nope' })).toEqual({ function: undefined, tab: undefined })
})

it('handles an empty search', () => {
  expect(validateSearch({})).toEqual({ function: undefined, tab: undefined })
})

import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({
  api: {
    health: vi.fn(async () => ({ runtimes: {} })),
    listFunctions: vi.fn(async () => ({
      functions: [
        { id: 'fn-1', name: 'order-lookup', path: '/tmp', runtime: 'node', handler: 'index.handler', timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '', localServices: [], trigger: null, savedEvents: [] },
        { id: 'fn-2', name: 's3-handler', path: '/tmp2', runtime: 'python', handler: 'index.handler', timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '', localServices: [], trigger: null, savedEvents: [] },
      ],
    })),
    setSelection: vi.fn(async () => ({})),
    listServices: vi.fn(async () => ({ services: [], docker: { available: false } })),
    listTriggerStatus: vi.fn(async () => ({})),
    detect: vi.fn(async () => ({ envFiles: [], projectTrigger: null })),
    listHistory: vi.fn(async () => ({ entries: [] })),
    deleteFunction: vi.fn(async () => ({})),
    invoke: vi.fn(async () => ({
      ok: true,
      phase: 'invoke',
      response: { statusCode: 200 },
      logs: '',
      report: { requestId: 'r1', durationMs: 1, billedMs: 1, memoryMb: 128, timedOut: false },
    })),
  },
}))

import { renderApp } from '@/test/route-harness'

it('selects the function named in the URL on load', async () => {
  await renderApp('/?function=s3-handler')

  expect(await screen.findByRole('heading', { name: 's3-handler' })).toBeInTheDocument()
})

it('falls back to the first function when the URL names one that does not exist', async () => {
  await renderApp('/?function=does-not-exist')

  expect(await screen.findByRole('heading', { name: 'order-lookup' })).toBeInTheDocument()
})

it('falls back to the first function when the URL has no function param', async () => {
  await renderApp('/')

  expect(await screen.findByRole('heading', { name: 'order-lookup' })).toBeInTheDocument()
})

it('pushes the clicked function\'s name into the URL as a new history entry', async () => {
  const router = await renderApp('/')
  await screen.findByText('s3-handler')
  const historyLenBefore = router.history.length

  fireEvent.click(screen.getByText('s3-handler'))

  expect(await screen.findByRole('heading', { name: 's3-handler' })).toBeInTheDocument()
  expect(router.state.location.search).toEqual({ function: 's3-handler', tab: undefined })
  expect(router.history.length).toBe(historyLenBefore + 1)
})

it('clears the function param when the selected function is deleted', async () => {
  const router = await renderApp('/?function=s3-handler')
  await screen.findByRole('heading', { name: 's3-handler' })

  // FunctionHeader (web/src/components/function-header.tsx) puts the
  // delete trigger behind an AlertDialog: an icon-only button labeled via
  // aria-label "Delete function" opens it, and the confirm action's visible
  // text is "Delete" ("Deleting…" while pending).
  fireEvent.click(screen.getByRole('button', { name: 'Delete function' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

  await screen.findByRole('heading', { name: 'order-lookup' })
  expect(router.state.location.search.function).toBeUndefined()
})

it('selects the tab named in the URL on load', async () => {
  await renderApp('/?function=order-lookup&tab=logs')

  expect(await screen.findByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
})

it('pushes the clicked tab into the URL as a new history entry', async () => {
  const router = await renderApp('/?function=order-lookup')
  await screen.findByRole('tab', { name: 'Report' })
  const historyLenBefore = router.history.length

  // Radix's TabsTrigger selects on `mousedown`, not `click` (and fireEvent.click
  // never synthesizes the mousedown in between) — a plain fireEvent.click is a
  // no-op here. mousedown is fired directly rather than via userEvent.click
  // because react-resizable-panels' document-level pointerdown listener
  // hit-tests with getBoundingClientRect, which jsdom always reports as zero
  // everywhere; that makes it treat every pointerdown as landing on the
  // resize handle and preventDefault() it, which per spec suppresses the
  // compatibility mousedown event userEvent.click would otherwise dispatch.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Report' }), { button: 0 })

  expect(await screen.findByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true')
  expect(router.state.location.search.tab).toBe('report')
  expect(router.history.length).toBe(historyLenBefore + 1)
})

it('corrects the URL off the Checks tab (via replace) when check results clear while checks is active', async () => {
  const user = userEvent.setup()
  const router = await renderApp('/?function=order-lookup')
  await screen.findByRole('heading', { name: 'order-lookup' })

  // Type a script (so the upcoming invoke produces check results, which is
  // what makes the Checks tab exist at all — see ResultPanel). Focused
  // directly, rather than via user.click, to avoid react-resizable-panels'
  // document-level pointerdown listener: it hit-tests with
  // getBoundingClientRect, which jsdom always reports as zero everywhere,
  // so it would treat the click as landing on the resize handle and
  // preventDefault() it, suppressing the compatibility mousedown a click
  // would otherwise produce.
  const scriptEditor = document.querySelectorAll('.cm-content')[1] as HTMLElement
  scriptEditor.focus()
  await user.keyboard('expect(response.statusCode).toBe(200)')

  fireEvent.click(screen.getByRole('button', { name: /invoke/i }))
  const checksTab = await screen.findByRole('tab', { name: 'Checks' })

  // Radix's TabsTrigger selects on `mousedown`, not `click` — see the
  // "pushes the clicked tab" test above for why this is a raw fireEvent
  // rather than userEvent.
  fireEvent.mouseDown(checksTab, { button: 0 })
  expect(await screen.findByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true')
  expect(router.state.location.search.tab).toBe('checks')

  const historyLenBefore = router.history.length

  // Editing the script clears checkResults (App's onScriptChange) while the
  // URL's tab param is still 'checks' — the passive-clearing scenario the
  // correcting effect exists for, without needing a second invoke.
  scriptEditor.focus()
  await user.keyboard('x')

  await waitFor(() => expect(router.state.location.search.tab).toBeUndefined())
  // replace, not push: the correction must not add a Back-able history entry
  expect(router.history.length).toBe(historyLenBefore)
})
