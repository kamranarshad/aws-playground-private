import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
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
