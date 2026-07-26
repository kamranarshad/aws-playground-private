import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    detect: vi.fn().mockResolvedValue({
      runtime: 'node', handlerCandidates: [], envFiles: ['.env'], projectServices: null,
    }),
    listServices: vi.fn().mockResolvedValue({
      docker: { available: false }, services: [],
    }),
    updateFunction: vi.fn().mockResolvedValue({}),
  },
}))

import { EnvEditor } from '@/components/env-editor'
import type { FunctionDef } from '@/lib/types'

const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: { AWS_SECRET_ACCESS_KEY: 'shhh', BUCKET: 'my-bucket' },
  envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

it('masks secret-looking values and leaves ordinary ones readable', async () => {
  render(<EnvEditor fn={fn} />, { wrapper })

  expect(await screen.findByLabelText('Value for AWS_SECRET_ACCESS_KEY'))
    .toHaveAttribute('type', 'password')
  expect(screen.getByLabelText('Value for BUCKET')).toHaveAttribute('type', 'text')
})

it('reveals a masked value on demand', async () => {
  render(<EnvEditor fn={fn} />, { wrapper })

  await userEvent.click(
    await screen.findByLabelText('Show value for AWS_SECRET_ACCESS_KEY'))

  expect(screen.getByLabelText('Value for AWS_SECRET_ACCESS_KEY'))
    .toHaveAttribute('type', 'text')
})

it('has no reveal button for values that are not secrets', async () => {
  render(<EnvEditor fn={fn} />, { wrapper })

  await screen.findByLabelText('Value for BUCKET')
  expect(screen.queryByLabelText('Show value for BUCKET')).not.toBeInTheDocument()
})
