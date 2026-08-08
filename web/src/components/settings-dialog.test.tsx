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
