import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { LogViewer } from '@/components/log-viewer'

it.each([undefined, '', '\n'])('says there are no logs for %p', (raw) => {
  render(<LogViewer raw={raw} />)

  expect(screen.getByText('No logs.')).toBeInTheDocument()
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
  const { container } = render(
    <LogViewer raw={'ERROR boom\n  File "h.py", line 3\n    raise ValueError\n'} />,
  )

  expect(container.querySelectorAll('[data-log-row]')).toHaveLength(1)
  expect(screen.getByText(/raise ValueError/)).toBeInTheDocument()
})

it('labels the build and invoke phases', () => {
  render(<LogViewer raw={'=== build ===\ntsc ok\n=== invoke ===\nhello\n'} />)

  expect(screen.getByText('build')).toBeInTheDocument()
  expect(screen.getByText('invoke')).toBeInTheDocument()
})
