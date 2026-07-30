import { render, screen } from '@testing-library/react'
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
