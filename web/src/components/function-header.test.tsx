import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    deleteFunction: vi.fn(), listTriggerStatus: vi.fn(),
    detect: vi.fn(), updateFunction: vi.fn(),
  },
}))

import { FunctionHeader } from '@/components/function-header'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
  autoTrace: false,
}

beforeEach(() => {
  vi.mocked(api.listTriggerStatus).mockResolvedValue({
    fn1: { state: 'listening', lastError: null, lastPolledAt: null },
  })
  vi.mocked(api.detect).mockResolvedValue({ runtime: 'node', handlerCandidates: [], projectTrigger: null })
})

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

it('does not show the trigger status badge when neither fn.trigger nor playground.json declares one', async () => {
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  await screen.findByRole('button', { name: 'Configure trigger' })
  expect(screen.queryByText(/Trigger:/)).not.toBeInTheDocument()
})

it('shows the trigger status badge when fn.trigger is enabled', async () => {
  render(<FunctionHeader fn={{ ...fn, trigger: { type: 'http', enabled: true } }} onDeleted={() => {}} />,
    { wrapper: makeWrapper() })
  expect(await screen.findByText('Trigger: listening')).toBeInTheDocument()
})

it('shows the trigger status badge for a playground.json-declared trigger even though fn.trigger is null', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(await screen.findByText('Trigger: listening')).toBeInTheDocument()
})

it('mounts the trigger button', async () => {
  render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(await screen.findByRole('button', { name: 'Configure trigger' })).toBeInTheDocument()
})

it('shows the auto-trace toggle for a Node function but not for a non-Node one', () => {
  const { rerender } = render(<FunctionHeader fn={fn} onDeleted={() => {}} />, { wrapper: makeWrapper() })
  expect(screen.getByText('Auto-trace')).toBeInTheDocument()
  rerender(<FunctionHeader fn={{ ...fn, runtime: 'python' }} onDeleted={() => {}} />)
  expect(screen.queryByText('Auto-trace')).not.toBeInTheDocument()
})
