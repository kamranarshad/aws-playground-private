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

import { fireEvent, screen } from '@testing-library/react'

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
