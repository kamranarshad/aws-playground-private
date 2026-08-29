import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { TraceTab } from '@/components/trace-tab'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

it('defaults to the list view', () => {
  render(<TraceTab spans={[span()]} />)
  // The list view renders duration text inline with the name; the
  // timeline view renders it only in a title attribute and the detail
  // panel, so this line existing as visible text is list-view-specific.
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('switches to the timeline view and back', async () => {
  render(<TraceTab spans={[span()]} />)
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByTestId('trace-bar-bb')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.queryByTestId('trace-bar-bb')).not.toBeInTheDocument()
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('shows the shared empty state in either view', async () => {
  render(<TraceTab spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})
