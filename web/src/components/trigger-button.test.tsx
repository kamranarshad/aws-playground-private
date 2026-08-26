import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn(), listFunctions: vi.fn(), detect: vi.fn() },
}))

import { TriggerButton } from '@/components/trigger-button'
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

afterEach(() => vi.clearAllMocks())

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function openPicker() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Configure trigger' }))
  return user
}

it('opens the picker when no playground.json trigger is declared', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  await openPicker()
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})

it('seeds the trigger fields from the function', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openPicker()
  expect(screen.getByLabelText('SQS trigger queue')).toHaveValue('my-queue')
})

it('shows the computed URL immediately for a function that already has an http trigger', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  await openPicker()
  expect(screen.getByLabelText('HTTP trigger URL')).toHaveValue('http://localhost:9500/test/...')
})

it('saves a new sqs trigger disabled — enabling it is the toggle button\'s job', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'SQS queue' }))
  await user.type(screen.getByLabelText('SQS trigger queue'), 'new-queue')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'sqs', queueName: 'new-queue', enabled: false },
  })
})

it('preserves an already-enabled sqs trigger\'s enabled state when just editing the queue name', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openPicker()
  const input = screen.getByLabelText('SQS trigger queue')
  await user.clear(input)
  await user.type(input, 'renamed-queue')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'sqs', queueName: 'renamed-queue', enabled: true },
  })
})

it('clears the trigger when the queue name is left blank', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.clear(screen.getByLabelText('SQS trigger queue'))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { trigger: null })
})

it('saves a new http trigger disabled, computing the URL from the function name', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'HTTP (API Gateway)' }))
  expect(screen.getByLabelText('HTTP trigger URL')).toHaveValue('http://localhost:9500/test/...')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'http', enabled: false },
  })
})

it('preserves an already-enabled http trigger\'s enabled state when reopened and saved', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 'http', enabled: true },
  })
})

it('clears the trigger when switched back to None', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'None' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { trigger: null })
})

it('shows a read-only label instead of the picker when playground.json declares a trigger', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  expect(await screen.findByTitle('Declared in playground.json — edit the file to change'))
    .toHaveTextContent('http')
  expect(screen.queryByRole('button', { name: 'Configure trigger' })).not.toBeInTheDocument()
})

it('shows s3 fields seeded from the function', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 's3', bucket: 'my-bucket', events: ['ObjectCreated'], enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openPicker()
  expect(screen.getByLabelText('S3 bucket')).toHaveValue('my-bucket')
  expect(screen.getByRole('checkbox', { name: 'Object Created' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Object Removed' })).not.toBeChecked()
})

it('saves a new s3 trigger disabled, with the selected bucket and event', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'S3 bucket' }))
  await user.type(screen.getByLabelText('S3 bucket'), 'uploads')
  await user.click(screen.getByRole('checkbox', { name: 'Object Created' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 's3', bucket: 'uploads', events: ['ObjectCreated'], enabled: false },
  })
})

it('includes prefix and suffix filters when set', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 's3', bucket: 'uploads', events: ['ObjectCreated'], enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.type(screen.getByLabelText('Key prefix (optional)'), 'images/')
  await user.type(screen.getByLabelText('Key suffix (optional)'), '.png')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', {
    trigger: { type: 's3', bucket: 'uploads', events: ['ObjectCreated'], prefix: 'images/', suffix: '.png', enabled: true },
  })
})

it('clears the s3 trigger when the bucket is left blank', async () => {
  render(<TriggerButton fn={{ ...fn, trigger: { type: 's3', bucket: 'uploads', events: ['ObjectCreated'], enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.clear(screen.getByLabelText('S3 bucket'))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { trigger: null })
})

it('clears the s3 trigger when no event type is selected', async () => {
  render(<TriggerButton fn={fn} />, { wrapper: makeWrapper() })
  const user = await openPicker()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'S3 bucket' }))
  await user.type(screen.getByLabelText('S3 bucket'), 'uploads')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { trigger: null })
})
