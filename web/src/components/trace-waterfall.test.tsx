import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { TracePanel } from '@/components/trace-panel'
import { TraceWaterfall } from '@/components/trace-waterfall'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'root-span',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

it('shows an empty state with no spans', () => {
  render(<TraceWaterfall spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders a bar for each span, positioned and sized by its time offset and duration', () => {
  const a = span({ spanId: 'a', name: 'first', startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000' })
  const b = span({ spanId: 'b', name: 'second', startTimeUnixNano: '1005000000', endTimeUnixNano: '1020000000' })
  render(<TraceWaterfall spans={[a, b]} />)
  const barA = screen.getByTestId('trace-bar-a')
  const barB = screen.getByTestId('trace-bar-b')
  // Total window is 0-20ms: "first" starts at 0% and covers 25% (5/20ms);
  // "second" starts at 25% and covers 75% (15/20ms).
  expect(barA.style.left).toBe('0%')
  expect(barA.style.width).toBe('25%')
  expect(barB.style.left).toBe('25%')
  expect(barB.style.width).toBe('75%')
})

it('renders axis ticks covering the total duration', () => {
  render(<TraceWaterfall spans={[span({ startTimeUnixNano: '1000000000', endTimeUnixNano: '1020000000' })]} />)
  expect(screen.getByText('0ms')).toBeInTheDocument()
  expect(screen.getByText('20ms')).toBeInTheDocument()
})

it('shows a span\'s full detail panel on click, and hides it again on a second click', async () => {
  const target = span({
    spanId: 'target', name: 'do-work', attributes: { 'http.method': 'GET' },
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
  })
  render(<TraceWaterfall spans={[target]} />)
  expect(screen.queryByText('http.method')).not.toBeInTheDocument()

  await userEvent.click(screen.getByTestId('trace-bar-target'))
  expect(screen.getByText('http.method')).toBeInTheDocument()
  expect(screen.getByText('"GET"')).toBeInTheDocument()

  await userEvent.click(screen.getByTestId('trace-bar-target'))
  expect(screen.queryByText('http.method')).not.toBeInTheDocument()
})

// Both views put names in one straight column, so a name sits at the same x
// whichever view you are in -- the two previously drifted to 12+depth*16 and
// depth*12 and a depth-0 name in the Timeline sat flush against the edge.
it('renders span names at one left offset, matching the list view', () => {
  const parent = span({ spanId: 'parent-1', name: 'parent-span' })
  const child = span({ spanId: 'child-1', parentSpanId: 'parent-1', name: 'child-span' })

  const listView = render(<TracePanel spans={[parent, child]} />)
  const listRowPad = (screen.getByText('parent-span').closest('li') as HTMLElement).style.paddingLeft
  listView.unmount()

  render(<TraceWaterfall spans={[parent, child]} />)
  const labels = ['parent-span', 'child-span'].map(
    (n) => (screen.getByText(n).closest('[data-testid="span-label"]') as HTMLElement))

  expect(labels[0].style.paddingLeft).toBe(labels[1].style.paddingLeft)
  expect(labels[0].style.paddingLeft).toBe(listRowPad)
  expect(labels[1].textContent).toContain('\u2514\u2500')
  expect(labels[0].textContent).not.toContain('\u2514\u2500')
})
