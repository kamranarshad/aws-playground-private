import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { listHistory: vi.fn(), clearHistory: vi.fn() },
}))

import { HistoryList } from '@/components/history-list'
import { api } from '@/lib/api'
import type { HistoryEntry } from '@/lib/types'

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'e1', ts: Date.now(), handler: 'app.handler', source: { type: 'manual' },
    event: {}, eventTruncated: false, response: {}, responseTruncated: false,
    error: null, logs: '', report: null, durationMs: 5, ok: true, truncated: false,
    ...overrides,
  }
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

it('badges a trigger-sourced run but not a manual one', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [
      entry({ id: 'manual1', source: { type: 'manual' } }),
      entry({ id: 'trig1', source: { type: 'trigger', messageId: 'm1' } }),
    ],
  })
  render(<HistoryList fnId="fn1" onLoadEvent={() => {}} />, { wrapper: makeWrapper() })

  // Wait for entries to be rendered by checking for the handler text
  const handlers = await screen.findAllByText('app.handler')

  // Get the buttons that are entry rows (they contain the handler text spans)
  const rows = handlers.map((span) => {
    let parent = span.parentElement
    while (parent && parent.tagName !== 'BUTTON') {
      parent = parent.parentElement
    }
    return parent
  }).filter(Boolean) as HTMLElement[]

  expect(within(rows[0]).queryByText('trigger')).not.toBeInTheDocument()
  expect(within(rows[1]).getByText('trigger')).toBeInTheDocument()
})

it('opens a run in a modal on click, and the list stays visible behind it', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [entry({ id: 'e1', handler: 'app.handler', event: { q: 1 }, response: { ok: true }, logs: 'line one' })],
  })
  const user = userEvent.setup()
  render(<HistoryList fnId="fn1" onLoadEvent={() => {}} />, { wrapper: makeWrapper() })

  await user.click(await screen.findByText('app.handler'))

  await screen.findByRole('dialog')
  // the row list is still in the document, not replaced by the modal
  expect(screen.getByText('1 runs (max 50 kept)')).toBeInTheDocument()
})

it('shows Request, Response, and Logs tabs, defaulting to Response', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [entry({ id: 'e1', event: { q: 1 }, response: { ok: true }, logs: 'line one' })],
  })
  const user = userEvent.setup()
  render(<HistoryList fnId="fn1" onLoadEvent={() => {}} />, { wrapper: makeWrapper() })
  await user.click(await screen.findByText('app.handler'))
  await screen.findByRole('dialog')

  expect(screen.getByRole('tab', { name: 'Request' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Response' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Logs' })).toBeInTheDocument()

  // Response tab is active by default, rendering the response's JSON tree.
  expect(screen.getByText('ok')).toBeInTheDocument()
  expect(screen.getByText('true')).toBeInTheDocument()
  expect(screen.queryByText('q')).not.toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Request' }))
  expect(screen.getByText('q')).toBeInTheDocument()
  expect(screen.queryByText('ok')).not.toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Logs' }))
  expect(screen.getByText('line one')).toBeInTheDocument()
})

it('shows the error on the Response tab when the run failed', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [entry({
      id: 'e1', ok: false, response: undefined,
      error: { type: 'Handler.Error', message: 'boom', stackTrace: ['at foo.js:1'] },
    })],
  })
  const user = userEvent.setup()
  render(<HistoryList fnId="fn1" onLoadEvent={() => {}} />, { wrapper: makeWrapper() })
  await user.click(await screen.findByText('app.handler'))
  await screen.findByRole('dialog')

  expect(screen.getByText(/Handler\.Error: boom/)).toBeInTheDocument()
  expect(screen.getByText(/at foo\.js:1/)).toBeInTheDocument()
})

it('loading the event closes the modal and passes the event text up', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [entry({ id: 'e1', event: { q: 2 } })],
  })
  const onLoadEvent = vi.fn()
  const user = userEvent.setup()
  render(<HistoryList fnId="fn1" onLoadEvent={onLoadEvent} />, { wrapper: makeWrapper() })

  await user.click(await screen.findByText('app.handler'))
  await screen.findByRole('dialog')
  await user.click(screen.getByRole('button', { name: /load event/i }))

  expect(onLoadEvent).toHaveBeenCalledWith(JSON.stringify({ q: 2 }, null, 2))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
