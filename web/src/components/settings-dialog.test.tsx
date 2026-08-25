import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn() },
}))

import { SettingsDialog } from '@/components/settings-dialog'
import { api } from '@/lib/api'
import { useFunctions } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
}

beforeEach(() => {
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
  vi.mocked(api.listFunctions).mockResolvedValue({ functions: [fn] })
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
  await user.click(await screen.findByRole('button', { name: 'Function settings' }))
  return user
}

// Mirrors how FunctionHeader passes cache data down: `fn` comes from a live
// useFunctions() query, not a prop the test controls directly. This matters
// for the reopen-reset regression below, since it's the query's object
// identity (not just its values) that the bug depends on.
function HostFromLiveQuery() {
  const { data } = useFunctions()
  const live = data?.[0]
  return live ? <SettingsDialog fn={live} /> : null
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

it('reseeds the Name field from the live function when reopened after a blank-name save', async () => {
  // The blank-name save patches the function with its own unchanged name, so
  // the refetch triggered by the mutation resolves to the same `fn` object
  // (mockResolvedValue keeps returning the same reference every call, the
  // same effect React Query's structural sharing produces in the real app
  // for a value-for-value-identical refetch). A reset effect keyed only on
  // `[fn]` never reruns in that case, so the Name field — left blank by the
  // user's edit — stays blank the next time the dialog opens, even though
  // the sidebar/header/server all show the correct, unchanged name.
  render(<HostFromLiveQuery />, { wrapper: makeWrapper() })

  const user = await openSettings()
  const input = await screen.findByLabelText('Name')
  await user.clear(input)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

  await openSettings()
  const reopened = await screen.findByLabelText('Name')
  await waitFor(() => expect(reopened).toHaveValue('test'))
})

it('seeds the trigger fields from the function', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openSettings()
  expect(screen.getByLabelText('SQS trigger queue')).toHaveValue('my-queue')
  expect(screen.getByRole('checkbox', { name: /invoke automatically/i })).toBeChecked()
})

it('saves the trigger config through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'SQS queue' }))
  await user.type(screen.getByLabelText('SQS trigger queue'), 'new-queue')
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({
    trigger: { type: 'sqs', queueName: 'new-queue', enabled: true },
  }))
})

it('clears the trigger when the queue name is left blank', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.clear(screen.getByLabelText('SQS trigger queue'))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({ trigger: null }))
})

it('seeds an http trigger and shows its computed URL', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openSettings()
  expect(screen.getByLabelText('HTTP trigger URL')).toHaveValue('http://localhost:9500/test/...')
  expect(screen.getByRole('checkbox', { name: /invoke automatically/i })).toBeChecked()
})

it('saves an http trigger through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'HTTP (API Gateway)' }))
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({
    trigger: { type: 'http', enabled: true },
  }))
})

it('clears the trigger when switched back to None', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'None' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({ trigger: null }))
})
