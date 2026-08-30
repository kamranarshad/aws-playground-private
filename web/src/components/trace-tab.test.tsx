import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { TraceTab, type TraceView } from '@/components/trace-tab'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

function ControlledTraceTab({ spans, initialView = 'list' }: { spans: Span[]; initialView?: TraceView }) {
  const [view, setView] = useState<TraceView>(initialView)
  return <TraceTab spans={spans} view={view} onViewChange={setView} />
}

it('defaults to the list view', () => {
  render(<ControlledTraceTab spans={[span()]} />)
  // The list view renders duration text inline with the name; the
  // timeline view renders it only in a title attribute and the detail
  // panel, so this line existing as visible text is list-view-specific.
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('switches to the timeline view and back', async () => {
  render(<ControlledTraceTab spans={[span()]} />)
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByTestId('trace-bar-bb')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.queryByTestId('trace-bar-bb')).not.toBeInTheDocument()
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('shows the shared empty state in either view', async () => {
  render(<ControlledTraceTab spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders whichever view the view prop names, without owning its own state', () => {
  const onViewChange = () => {}
  render(<TraceTab spans={[span()]} view="timeline" onViewChange={onViewChange} />)
  expect(screen.getByTestId('trace-bar-bb')).toBeInTheDocument()
})

it('calls onViewChange with the clicked view instead of switching itself', async () => {
  const seen: TraceView[] = []
  render(<TraceTab spans={[span()]} view="list" onViewChange={(v) => seen.push(v)} />)
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  // The component is controlled: clicking Timeline reports the intent via
  // onViewChange but does not switch the rendered view itself, since `view`
  // prop stayed 'list' in this test (no state lifted here).
  expect(seen).toEqual(['timeline'])
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})
