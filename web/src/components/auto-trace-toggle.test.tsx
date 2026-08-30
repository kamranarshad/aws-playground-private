import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { updateFunction: vi.fn().mockResolvedValue({}) } }))

import { AutoTraceToggle } from '@/components/auto-trace-toggle'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const nodeFn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null,
  savedEvents: [], autoTrace: false,
}

it('renders nothing for a non-Node runtime', () => {
  const { container } = render(<AutoTraceToggle fn={{ ...nodeFn, runtime: 'python' }} />, { wrapper: makeWrapper() })
  expect(container).toBeEmptyDOMElement()
})

it('toggles autoTrace via PATCH', async () => {
  render(<AutoTraceToggle fn={nodeFn} />, { wrapper: makeWrapper() })
  await userEvent.click(screen.getByRole('checkbox'))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { autoTrace: true })
})
