import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResultPanel } from '@/components/result-panel'
import type { InvokeResult } from '@/lib/types'

function stubClipboard() {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  })
  return writeText
}

afterEach(() => vi.clearAllMocks())

const ok: InvokeResult = {
  ok: true, phase: 'invoke', response: { statusCode: 200, body: 'hi' }, logs: 'log line',
  report: { requestId: 'req-1', durationMs: 12.5, billedMs: 13, memoryMb: 128, timedOut: false },
}

const failed: InvokeResult = {
  ok: false, phase: 'build',
  error: { type: 'Build.Failed', message: 'Build command failed (exit 1): npm run build', stackTrace: [] },
  logs: 'tsc error TS2345',
  report: { requestId: '', durationMs: 0, billedMs: 0, memoryMb: 128, timedOut: false, buildMs: 340 },
}

it('prompts to invoke before there is a result', () => {
  render(<ResultPanel result={null} />)

  expect(screen.getByText('Invoke to see the response.')).toBeInTheDocument()
})

it('shows the error type and message when the invoke failed', () => {
  render(<ResultPanel result={failed} />)

  expect(screen.getByText(/Build\.Failed: Build command failed/)).toBeInTheDocument()
})

it('reports build duration separately from handler duration', async () => {
  render(<ResultPanel result={failed} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Report' }))

  expect(screen.getByText(/Build Duration: 340 ms/)).toBeInTheDocument()
})

it('badges a successful run with its duration', () => {
  render(<ResultPanel result={ok} />)

  expect(screen.getByText(/OK · 12\.5ms/)).toBeInTheDocument()
})

it('renders the response as a tree rather than one flat blob', () => {
  render(<ResultPanel result={ok} />)

  expect(screen.getByText('statusCode')).toBeInTheDocument()
  expect(screen.getByLabelText('Collapse root')).toBeInTheDocument()
})

// Minified: the clipboard is a handoff to curl/an editor/a test fixture, where
// the tree's own indentation is what you'd strip back out.
it('copies the response as minified JSON', async () => {
  const writeText = stubClipboard()
  render(<ResultPanel result={ok} />)

  await userEvent.click(screen.getByLabelText('Copy response JSON'))

  expect(writeText).toHaveBeenCalledWith('{"statusCode":200,"body":"hi"}')
})

// A failed invoke has an error and a stack trace, not a response to copy.
it('offers nothing to copy when there is no response', () => {
  render(<ResultPanel result={failed} />)

  expect(screen.queryByLabelText('Copy response JSON')).not.toBeInTheDocument()
})

// `async () => {}` returns undefined, which JSON.stringify turns into undefined
// rather than a string. That is a successful invoke, not an error.
it('handles a successful invoke that returned nothing', () => {
  render(<ResultPanel result={{ ...ok, response: undefined }} />)

  expect(screen.getByText('undefined')).toBeInTheDocument()
  expect(screen.queryByText(/^undefined: undefined/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Copy response JSON')).not.toBeInTheDocument()
})

// The Logs tab used to be a raw <pre>: a traceback was a dozen unstructured
// rows and nothing separated an error from an info line.
it('renders logs as parsed rows rather than one flat blob', async () => {
  const { container } = render(
    <ResultPanel result={{ ...ok, logs: '2026-07-30T10:23:45.123Z ERROR boom\n' }} />,
  )

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('10:23:45.123')).toBeInTheDocument()
  // Not getByText('ERROR'): the Logs tab's level filter toolbar has its own
  // ERROR chip, so a bare text query is ambiguous once the tab is open.
  expect(container.querySelector('.text-destructive')).toHaveTextContent('ERROR')
  expect(screen.getByText('boom')).toBeInTheDocument()
})

it('still says there are no logs when the run printed nothing', async () => {
  render(<ResultPanel result={{ ...ok, logs: '' }} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('No logs.')).toBeInTheDocument()
})

it('shows nothing for the assertion when no saved event is active', () => {
  render(<ResultPanel result={ok} />)

  expect(screen.queryByLabelText('Assertion passed')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Assertion failed')).not.toBeInTheDocument()
})

it('marks the assertion as passing when the response status matches', () => {
  render(<ResultPanel result={ok} expectedStatus={200} />)

  expect(screen.getByLabelText('Assertion passed')).toBeInTheDocument()
  expect(screen.getByText('Expected 200')).toBeInTheDocument()
})

it('marks the assertion as failing when the response status does not match', () => {
  render(<ResultPanel result={ok} expectedStatus={500} />)

  expect(screen.getByLabelText('Assertion failed')).toBeInTheDocument()
  expect(screen.getByText(/Expected 500.*got 200/)).toBeInTheDocument()
})

it('fails the assertion when the invoke itself errored', () => {
  render(<ResultPanel result={failed} expectedStatus={200} />)

  expect(screen.getByLabelText('Assertion failed')).toBeInTheDocument()
  expect(screen.getByText(/Expected 200.*got no status/)).toBeInTheDocument()
})
