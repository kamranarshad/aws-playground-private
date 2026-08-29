import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TracePanel } from '@/components/trace-panel'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'root-span',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

it('shows an empty state with no spans', () => {
  render(<TracePanel spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders a span with its name, duration, and attributes', () => {
  render(<TracePanel spans={[span({ name: 'do-work', attributes: { 'http.method': 'GET' } })]} />)
  expect(screen.getByText('do-work')).toBeInTheDocument()
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
  expect(screen.getByText(/http\.method="GET"/)).toBeInTheDocument()
})

it('indents a child span under its parent', () => {
  const parent = span({ spanId: 'parent-1', name: 'parent-span' })
  const child = span({ spanId: 'child-1', parentSpanId: 'parent-1', name: 'child-span' })
  render(<TracePanel spans={[parent, child]} />)
  const childRow = screen.getByText('child-span').closest('li')
  const parentRow = screen.getByText('parent-span').closest('li')
  const childPad = Number((childRow?.style.paddingLeft ?? '0').replace('px', ''))
  const parentPad = Number((parentRow?.style.paddingLeft ?? '0').replace('px', ''))
  expect(childPad).toBeGreaterThan(parentPad)
})
