import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    listServices: vi.fn().mockResolvedValue({ docker: { available: true }, services: [] }),
    startService: vi.fn().mockResolvedValue({ state: 'running' }),
    stopService: vi.fn().mockResolvedValue({ state: 'stopped' }),
  },
}))

import { ServiceRow } from '@/components/service-row'
import type { LocalService } from '@/lib/types'

const minio: LocalService = {
  name: 'minio', label: 'S3 (MinIO)', shortLabel: 'S3', note: null,
  state: 'running', endpoint: 'http://127.0.0.1:9400',
  consoleUrl: 'http://127.0.0.1:9401',
  credentials: [
    { label: 'Access key', value: 'playground' },
    { label: 'Secret key', value: 'playground123' },
  ],
}

const redis: LocalService = {
  name: 'redis', label: 'ElastiCache (Redis)', shortLabel: 'Redis', note: null,
  state: 'stopped', endpoint: 'redis://127.0.0.1:9403', consoleUrl: null,
  credentials: [],
}

// Built per render call, not per React render: a client constructed inside
// the wrapper component would be discarded on every re-render.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

function renderRow(svc: LocalService) {
  return render(
    <ul>
      <ServiceRow svc={svc} selected={false} selectable onSelectedChange={() => {}} />
    </ul>,
    { wrapper: makeWrapper() },
  )
}

it('shows each credential with its label', () => {
  renderRow(minio)

  expect(screen.getByText('Access key')).toBeInTheDocument()
  expect(screen.getByText('Secret key')).toBeInTheDocument()
  expect(screen.getByText('playground')).toBeInTheDocument()
  expect(screen.getByText('playground123')).toBeInTheDocument()
})

it('says so when a service has no authentication', () => {
  renderRow(redis)

  expect(screen.getByText('no authentication')).toBeInTheDocument()
})

it('copies a credential to the clipboard when clicked', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  })
  renderRow(minio)

  await userEvent.click(screen.getByLabelText('Copy playground123'))

  expect(writeText).toHaveBeenCalledWith('playground123')
})

it('offers the console link only while the service is running', () => {
  const { unmount } = renderRow(minio)
  expect(screen.getByText('Open console')).toBeInTheDocument()
  unmount()

  renderRow({ ...minio, state: 'stopped' })
  expect(screen.queryByText('Open console')).not.toBeInTheDocument()
})
