import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn(), detect: vi.fn() },
}))

import { TriggerToggle } from '@/components/trigger-toggle'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
  vi.mocked(api.detect).mockResolvedValue({ runtime: 'node', handlerCandidates: [], projectTrigger: null })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

it('renders nothing when the function has no trigger configured', () => {
  render(<TriggerToggle fn={fn} />, { wrapper: makeWrapper() })
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('renders nothing once playground.json is confirmed to declare the trigger', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(<TriggerToggle fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
})

it('enables a disabled trigger on click, preserving its type and queue name', async () => {
  render(<TriggerToggle fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: false } }} />,
    { wrapper: makeWrapper() })
  const button = await screen.findByRole('button', { name: 'Enable trigger' })
  expect(button.querySelector('.text-success')).toBeNull()

  await userEvent.click(button)

  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'sqs', queueName: 'my-queue', enabled: true },
  })
})

it('disables an enabled trigger on click, flashing red then settling back to neutral', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<TriggerToggle fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const button = await screen.findByRole('button', { name: 'Disable trigger' })
  expect(button.querySelector('.text-success')).toBeTruthy()

  await user.click(button)

  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'http', enabled: false },
  })
  expect(button.querySelector('.text-destructive')).toBeTruthy()

  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(button.querySelector('.text-destructive')).toBeNull()
})
