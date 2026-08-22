import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { AppSidebar } from '@/components/app-sidebar'
import type { FunctionDef } from '@/lib/types'

let nextId = 0

function makeFn(overrides: Partial<FunctionDef> = {}): FunctionDef {
  nextId += 1
  return {
    id: `fn-${nextId}`, name: `function-${nextId}`, path: '/tmp/fn', runtime: 'node',
    handler: 'index.handler', timeoutMs: 3000, memoryMb: 128, jarPath: null,
    env: {}, envFile: '', buildCommand: '', localServices: [], savedEvents: [],
    ...overrides,
  }
}

function noop() {}

it('lists every function with its name and language', () => {
  const functions = [makeFn({ name: 'order-lookup', runtime: 'python' }), makeFn({ name: 'hello-world', runtime: 'node' })]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.getByText('hello-world')).toBeInTheDocument()
})

it('calls onSelect with the clicked function id', async () => {
  const fn = makeFn({ name: 'order-lookup' })
  const onSelect = vi.fn()
  render(<AppSidebar functions={[fn]} selectedId={null} onSelect={onSelect} onAdd={noop} />)

  await userEvent.click(screen.getByText('order-lookup'))

  expect(onSelect).toHaveBeenCalledWith(fn.id)
})

it('says there are no functions yet when the list is empty', () => {
  render(<AppSidebar functions={[]} selectedId={null} onSelect={noop} onAdd={noop} />)

  expect(screen.getByText('No functions yet.')).toBeInTheDocument()
})

// ---- search and filter ---------------------------------------------------

it('offers no search or filter toolbar when there are no functions', () => {
  render(<AppSidebar functions={[]} selectedId={null} onSelect={noop} onAdd={noop} />)

  expect(screen.queryByPlaceholderText('Search functions…')).not.toBeInTheDocument()
})

it('filters the list by the search box, live as you type', async () => {
  const functions = [makeFn({ name: 'order-lookup' }), makeFn({ name: 'hello-world' })]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)

  await userEvent.type(screen.getByPlaceholderText('Search functions…'), 'order')

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.queryByText('hello-world')).not.toBeInTheDocument()
})

it('shows one chip per language actually present, not every possible runtime', () => {
  const functions = [makeFn({ runtime: 'python' }), makeFn({ runtime: 'node' })]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)

  expect(screen.getByRole('button', { name: 'python' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'node' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'java' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'provided' })).not.toBeInTheDocument()
})

it('shows only that language when its chip is clicked', async () => {
  const functions = [
    makeFn({ name: 'order-lookup', runtime: 'python' }),
    makeFn({ name: 'hello-world', runtime: 'node' }),
  ]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)

  await userEvent.click(screen.getByRole('button', { name: 'python' }))

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.queryByText('hello-world')).not.toBeInTheDocument()
})

it('shows every language again when the solo\'d chip is clicked again', async () => {
  const functions = [
    makeFn({ name: 'order-lookup', runtime: 'python' }),
    makeFn({ name: 'hello-world', runtime: 'node' }),
  ]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)
  await userEvent.click(screen.getByRole('button', { name: 'python' }))

  await userEvent.click(screen.getByRole('button', { name: 'python' }))

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.getByText('hello-world')).toBeInTheDocument()
})

it('switches solo to the newly clicked language', async () => {
  const functions = [
    makeFn({ name: 'order-lookup', runtime: 'python' }),
    makeFn({ name: 'hello-world', runtime: 'node' }),
    makeFn({ name: 'batch-job', runtime: 'java' }),
  ]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)
  await userEvent.click(screen.getByRole('button', { name: 'java' }))

  await userEvent.click(screen.getByRole('button', { name: 'python' }))

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.queryByText('hello-world')).not.toBeInTheDocument()
  expect(screen.queryByText('batch-job')).not.toBeInTheDocument()
})

it('combines the search box and a solo\'d language', async () => {
  const functions = [
    makeFn({ name: 'order-lookup', runtime: 'python' }),
    makeFn({ name: 'status-check', runtime: 'python' }),
    makeFn({ name: 'order-cleanup', runtime: 'node' }),
  ]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)
  await userEvent.click(screen.getByRole('button', { name: 'python' }))

  await userEvent.type(screen.getByPlaceholderText('Search functions…'), 'order')

  // Soloing python already drops order-cleanup (node); searching "order"
  // then narrows the remaining python functions down to just one — proving
  // the language solo and the text search combine (AND) rather than either
  // alone deciding the result.
  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.queryByText('status-check')).not.toBeInTheDocument()
  expect(screen.queryByText('order-cleanup')).not.toBeInTheDocument()
})

it('shows a dedicated empty state when the filters match nothing, distinct from having no functions at all', async () => {
  const functions = [makeFn({ name: 'order-lookup' })]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)

  await userEvent.type(screen.getByPlaceholderText('Search functions…'), 'nope')

  expect(screen.getByText('No functions match.')).toBeInTheDocument()
  expect(screen.queryByText('No functions yet.')).not.toBeInTheDocument()
})

it('clears the search and re-enables every language from the empty-match state', async () => {
  const functions = [
    makeFn({ name: 'order-lookup', runtime: 'python' }),
    makeFn({ name: 'hello-world', runtime: 'node' }),
  ]
  render(<AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />)
  await userEvent.click(screen.getByRole('button', { name: 'python' }))
  await userEvent.type(screen.getByPlaceholderText('Search functions…'), 'hello')
  expect(screen.getByText('No functions match.')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Clear' }))

  expect(screen.getByText('order-lookup')).toBeInTheDocument()
  expect(screen.getByText('hello-world')).toBeInTheDocument()
})

// A new runtime showing up later (a function of a language not seen before)
// must default to visible — it was never explicitly toggled off.
it('defaults a newly-appearing language to visible', () => {
  const functions = [makeFn({ name: 'order-lookup', runtime: 'python' })]
  const { rerender } = render(
    <AppSidebar functions={functions} selectedId={null} onSelect={noop} onAdd={noop} />,
  )

  rerender(
    <AppSidebar
      functions={[...functions, makeFn({ name: 'batch-job', runtime: 'java' })]}
      selectedId={null} onSelect={noop} onAdd={noop}
    />,
  )

  expect(screen.getByText('batch-job')).toBeInTheDocument()
})
