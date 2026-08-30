import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { detect: vi.fn(), listServices: vi.fn(), updateFunction: vi.fn() },
}))

import { EnvEditor } from '@/components/env-editor'
import { api } from '@/lib/api'
import type { Detection, FunctionDef, LocalService, ServicesStatus } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: { AWS_SECRET_ACCESS_KEY: 'shhh', BUCKET: 'my-bucket' },
  envFile: 'auto', buildCommand: '', localServices: [], trigger: null, savedEvents: [],
  autoTrace: false,
}

const detection: Detection = {
  runtime: 'node', handlerCandidates: [], envFiles: ['.env'], projectServices: null,
}

const minio: LocalService = {
  name: 'minio', label: 'S3 (MinIO)', shortLabel: 'S3', note: null,
  state: 'stopped', endpoint: 'http://127.0.0.1:9400', consoleUrl: null, credentials: [],
}

const withServices: ServicesStatus = { docker: { available: true }, services: [minio] }

beforeEach(() => {
  vi.mocked(api.detect).mockResolvedValue(detection)
  vi.mocked(api.listServices).mockResolvedValue({ docker: { available: false }, services: [] })
  vi.mocked(api.updateFunction).mockResolvedValue(fn)
})

// Call counts are assertions here, so they must not leak between tests.
afterEach(() => vi.clearAllMocks())

// The client must outlive re-renders — building it inside the wrapper
// component would throw the cache away on every render, which defeats
// exactly the deduplication one of these tests checks.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

it('masks secret-looking values and leaves ordinary ones readable', async () => {
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  expect(await screen.findByLabelText('Value for AWS_SECRET_ACCESS_KEY'))
    .toHaveAttribute('type', 'password')
  expect(screen.getByLabelText('Value for BUCKET')).toHaveAttribute('type', 'text')
})

it('reveals a masked value on demand', async () => {
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  await userEvent.click(
    await screen.findByLabelText('Show value for AWS_SECRET_ACCESS_KEY'))

  expect(screen.getByLabelText('Value for AWS_SECRET_ACCESS_KEY'))
    .toHaveAttribute('type', 'text')
})

it('has no reveal button for values that are not secrets', async () => {
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  await screen.findByLabelText('Value for BUCKET')
  expect(screen.queryByLabelText('Show value for BUCKET')).not.toBeInTheDocument()
})

// The env-file picker and the playground.json service list both come out of
// one /api/detect call. Keying them separately made every function click
// re-run project detection twice — readdir + regex scan of the project, on
// the server, for the same answer.
it('runs project detection once, not once per consumer', async () => {
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  await screen.findByLabelText('Value for BUCKET')

  expect(api.detect).toHaveBeenCalledTimes(1)
})

it('offers a toggle per local service when the project has no playground.json', async () => {
  vi.mocked(api.listServices).mockResolvedValue(withServices)

  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  expect(await screen.findByRole('checkbox', { name: 'S3' })).not.toBeChecked()
})

it('enabling a service toggle saves it on the function', async () => {
  vi.mocked(api.listServices).mockResolvedValue(withServices)
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'S3' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn1', { localServices: ['minio'] })
})

it('shows playground.json services as read-only, with no toggles', async () => {
  vi.mocked(api.listServices).mockResolvedValue(withServices)
  vi.mocked(api.detect).mockResolvedValue({ ...detection, projectServices: ['minio'] })

  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })

  expect(await screen.findByText('from playground.json')).toBeInTheDocument()
  expect(screen.getByText('S3')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: 'S3' })).not.toBeInTheDocument()
})

// Radix's Select can't be opened under jsdom (it needs pointer APIs jsdom
// lacks), so assert on the trigger, which is what tells the user whether a
// .env was found.
it('says whether a .env was detected in the project', async () => {
  vi.mocked(api.detect).mockResolvedValue({ ...detection, envFiles: ['.env', '.env.test'] })
  const { unmount } = render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })
  expect(await screen.findByText('Auto (.env)')).toBeInTheDocument()
  unmount()

  vi.mocked(api.detect).mockResolvedValue({ ...detection, envFiles: [] })
  render(<EnvEditor fn={fn} />, { wrapper: makeWrapper() })
  expect(await screen.findByText('Auto (no .env)')).toBeInTheDocument()
})
