import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'

import { LogViewer } from '@/components/log-viewer'

it.each([undefined, '', '\n', '   \n', '  \n\t\n'])('says there are no logs for %p', (raw) => {
  render(<LogViewer raw={raw} />)

  expect(screen.getByText('No logs.')).toBeInTheDocument()
})

// The time cell is a fixed-width span rather than a real grid column (see
// TIME_CELL), so "no column" means every row's time span carries `hidden`.
function timeCells(container: HTMLElement) {
  return Array.from(container.querySelectorAll('span')).filter((el) =>
    el.className.includes('w-[12ch]'),
  )
}

it('hides the time column when no row in the batch has a time', () => {
  const { container } = render(<LogViewer raw={'LEVEL:name:one\nLEVEL:name:two\n'} />)

  const cells = timeCells(container)
  expect(cells).toHaveLength(2)
  cells.forEach((cell) => expect(cell).toHaveClass('hidden'))
})

// Mixed logs are the point: one timed line must not shrink the column out
// from under a neighbour that has none, or the two rows stop lining up.
it('keeps the time column for every row when at least one has a time', () => {
  const { container } = render(
    <LogViewer raw={'2026-07-30T10:23:45.123Z boot\nno timestamp here\n'} />,
  )

  const cells = timeCells(container)
  expect(cells).toHaveLength(2)
  cells.forEach((cell) => expect(cell).not.toHaveClass('hidden'))
  expect(cells[0]).toHaveTextContent('10:23:45.123')
  expect(cells[1]).toHaveTextContent('')
})

it('shows the time and level alongside the message', () => {
  // Braces, not a quoted attribute: JSX string attributes do not process \n.
  render(<LogViewer raw={'2026-07-30T10:23:45.123Z ERROR connection refused\n'} />)

  expect(screen.getByText('10:23:45.123')).toBeInTheDocument()
  expect(screen.getByText('ERROR')).toBeInTheDocument()
  expect(screen.getByText('connection refused')).toBeInTheDocument()
})

// The level is uppercased in the markup, not by CSS, so what a screen reader
// and a test see is what is on screen.
it('renders a plain line with no level text at all', () => {
  render(<LogViewer raw={'hello from the handler\n'} />)

  expect(screen.getByText('hello from the handler')).toBeInTheDocument()
  expect(screen.queryByText('INFO')).not.toBeInTheDocument()
})

it('renders a folded traceback as a single row', () => {
  render(<LogViewer raw={'ERROR boom\n  File "h.py", line 3\n    raise ValueError\n'} />)

  // One element holding both ends of the trace is the proof it folded:
  // unfolded, these would be three separate rows.
  expect(screen.getByText(/boom[\s\S]*raise ValueError/)).toBeInTheDocument()
})

it('labels the build and invoke phases', () => {
  render(<LogViewer raw={'=== build ===\ntsc ok\n=== invoke ===\nhello\n'} />)

  expect(screen.getByText('build')).toBeInTheDocument()
  expect(screen.getByText('invoke')).toBeInTheDocument()
})

const STRUCTURED =
  '{"timestamp":"2026-07-31T02:35:13.683Z","status":"warn","message":"slow call","service":"orders-api"}\n'

it('shows a structured line in the same columns as a text one', () => {
  render(<LogViewer raw={STRUCTURED} />)

  expect(screen.getByText('02:35:13.683')).toBeInTheDocument()
  expect(screen.getByText('WARN')).toBeInTheDocument()
  expect(screen.getByText('slow call')).toBeInTheDocument()
  // The raw object is not the row's text — that was the old behaviour.
  expect(screen.queryByText(/"ddsource"|^\{/)).not.toBeInTheDocument()
})

// The full object is one click down, the way Datadog's list works. Asserted
// on the tree's quoted rendering rather than the bare key: the inline
// metadata below already prints `service=orders-api` while collapsed, so a
// bare `service` would be found either way and prove nothing.
it('expands a structured line into a tree of its attributes', async () => {
  render(<LogViewer raw={STRUCTURED} />)
  expect(screen.queryByText('"orders-api"')).not.toBeInTheDocument()

  await userEvent.click(screen.getByLabelText(/^Expand log entry/))

  expect(screen.getByText('service')).toBeInTheDocument()
  expect(screen.getByText('"orders-api"')).toBeInTheDocument()
  // The fields the columns took are in the tree too, so the entry reads in
  // context rather than as the leftovers.
  expect(screen.getByText('"slow call"')).toBeInTheDocument()
})

it('collapses an expanded entry again', async () => {
  render(<LogViewer raw={STRUCTURED} />)
  await userEvent.click(screen.getByLabelText(/^Expand log entry/))

  await userEvent.click(screen.getByLabelText(/^Collapse log entry/))

  expect(screen.queryByText('"orders-api"')).not.toBeInTheDocument()
})

// A plain text log has nothing to expand, so it carries no chevron gutter.
it('offers no expander for plain text lines', () => {
  render(<LogViewer raw={'2026-07-31T02:35:13.683Z INFO hello\n'} />)

  expect(screen.queryByLabelText(/log entry/)).not.toBeInTheDocument()
})

// Text lines print their metadata after the message; structured ones did
// not, which made the same entry read as barer in JSON than in text.
it('shows leftover attributes inline after a structured message', () => {
  render(<LogViewer raw={STRUCTURED} />)

  expect(screen.getByText('service=orders-api')).toBeInTheDocument()
})

// Every pair on one text run, so the one-line clamp measures the row width
// rather than counting each pair as a line of its own.
it('renders all leftover attributes as a single line', () => {
  render(
    <LogViewer
      raw={'{"level":"info","msg":"x","service":"orders-api","order_id":"A-1","duration_ms":812}\n'}
    />,
  )

  // Single-spaced here, double-spaced on screen: getByText's default
  // normalizer collapses runs of whitespace before comparing.
  expect(screen.getByText('service=orders-api order_id=A-1 duration_ms=812'))
    .toBeInTheDocument()
})

// A whole stack inlined would bury the message it belongs to; the chevron
// is what that is for.
it('summarises a nested attribute rather than inlining it', () => {
  render(<LogViewer raw={'{"level":"error","msg":"boom","error":{"kind":"RangeError"}}\n'} />)

  expect(screen.getByText('error={…}')).toBeInTheDocument()
  expect(screen.queryByText(/RangeError/)).not.toBeInTheDocument()
})
