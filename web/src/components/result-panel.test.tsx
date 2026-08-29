import { useState } from 'react'
import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResultPanel } from '@/components/result-panel'
import type { InvokeResult, ResultTab } from '@/lib/types'

function ControlledResultPanel(props: Omit<ComponentProps<typeof ResultPanel>, 'activeTab' | 'onActiveTabChange'>) {
  const [tab, setTab] = useState<ResultTab>('response')
  return <ResultPanel {...props} activeTab={tab} onActiveTabChange={setTab} />
}

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
  render(<ControlledResultPanel result={null} />)

  expect(screen.getByText('Invoke to see the response.')).toBeInTheDocument()
})

it('shows the error type and message when the invoke failed', () => {
  render(<ControlledResultPanel result={failed} />)

  expect(screen.getByText(/Build\.Failed: Build command failed/)).toBeInTheDocument()
})

it('reports build duration separately from handler duration', async () => {
  render(<ControlledResultPanel result={failed} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Report' }))

  expect(screen.getByText(/Build Duration: 340 ms/)).toBeInTheDocument()
})

it('shows Init Duration in the Report tab when the report includes initMs', async () => {
  const withInit: InvokeResult = {
    ...ok,
    report: { ...ok.report, initMs: 42.5 },
  }
  render(<ResultPanel result={withInit} />)
  await userEvent.click(screen.getByText('Report'))
  expect(screen.getByText(/Init Duration: 42.5 ms/)).toBeInTheDocument()
})

it('badges a successful run with its duration', () => {
  render(<ControlledResultPanel result={ok} />)

  expect(screen.getByText(/OK · 12\.5ms/)).toBeInTheDocument()
})

it('renders the response as a tree rather than one flat blob', () => {
  render(<ControlledResultPanel result={ok} />)

  expect(screen.getByText('statusCode')).toBeInTheDocument()
  expect(screen.getByLabelText('Collapse root')).toBeInTheDocument()
})

// Minified: the clipboard is a handoff to curl/an editor/a test fixture, where
// the tree's own indentation is what you'd strip back out.
it('copies the response as minified JSON', async () => {
  const writeText = stubClipboard()
  render(<ControlledResultPanel result={ok} />)

  await userEvent.click(screen.getByLabelText('Copy response JSON'))

  expect(writeText).toHaveBeenCalledWith('{"statusCode":200,"body":"hi"}')
})

// A failed invoke has an error and a stack trace, not a response to copy.
it('offers nothing to copy when there is no response', () => {
  render(<ControlledResultPanel result={failed} />)

  expect(screen.queryByLabelText('Copy response JSON')).not.toBeInTheDocument()
})

// `async () => {}` returns undefined, which JSON.stringify turns into undefined
// rather than a string. That is a successful invoke, not an error.
it('handles a successful invoke that returned nothing', () => {
  render(<ControlledResultPanel result={{ ...ok, response: undefined }} />)

  expect(screen.getByText('undefined')).toBeInTheDocument()
  expect(screen.queryByText(/^undefined: undefined/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Copy response JSON')).not.toBeInTheDocument()
})

// The Logs tab used to be a raw <pre>: a traceback was a dozen unstructured
// rows and nothing separated an error from an info line.
it('renders logs as parsed rows rather than one flat blob', async () => {
  const { container } = render(
    <ControlledResultPanel result={{ ...ok, logs: '2026-07-30T10:23:45.123Z ERROR boom\n' }} />,
  )

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('10:23:45.123')).toBeInTheDocument()
  // Not getByText('ERROR'): the Logs tab's level filter toolbar has its own
  // ERROR chip, so a bare text query is ambiguous once the tab is open.
  expect(container.querySelector('.text-destructive')).toHaveTextContent('ERROR')
  expect(screen.getByText('boom')).toBeInTheDocument()
})

it('still says there are no logs when the run printed nothing', async () => {
  render(<ControlledResultPanel result={{ ...ok, logs: '' }} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('No logs.')).toBeInTheDocument()
})

const mixedChecks = {
  results: [
    { matcher: 'toBe' as const, actual: 200, expected: 200, pass: true },
    { matcher: 'toContain' as const, actual: 'hi', expected: 'ok', pass: false },
  ],
  scriptError: null,
}

it('shows neither the Checks tab nor a summary chip when no checks have run', () => {
  render(<ControlledResultPanel result={ok} />)

  expect(screen.queryByRole('tab', { name: 'Checks' })).not.toBeInTheDocument()
  expect(screen.queryByText(/passed/)).not.toBeInTheDocument()
})

it('summarizes how many checks passed', () => {
  render(<ControlledResultPanel result={ok} checkResults={mixedChecks} />)

  expect(screen.getByText('1/2 passed')).toBeInTheDocument()
})

it('lists each check with its matcher, expected, and actual value', async () => {
  render(<ControlledResultPanel result={ok} checkResults={mixedChecks} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('toBe(200) — actual: 200')).toBeInTheDocument()
  expect(screen.getByText('toContain("ok") — actual: "hi"')).toBeInTheDocument()
  expect(screen.getByLabelText('Check passed')).toBeInTheDocument()
  expect(screen.getByLabelText('Check failed')).toBeInTheDocument()
})

it('shows a script-error row alongside any results gathered before it threw', async () => {
  render(
    <ControlledResultPanel
      result={ok}
      checkResults={{
        results: [{ matcher: 'toBe' as const, actual: 200, expected: 200, pass: true }],
        scriptError: 'response.body.nope is not a function',
      }}
    />,
  )

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('response.body.nope is not a function')).toBeInTheDocument()
  expect(screen.getByLabelText('Script error')).toBeInTheDocument()
})

it('says a script had no assertions rather than showing an empty list', async () => {
  render(<ControlledResultPanel result={ok} checkResults={{ results: [], scriptError: null }} />)

  expect(screen.getByText('no assertions')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('Script had no assertions.')).toBeInTheDocument()
})

// A script that threw before its first expect() has no results to count.
// "no assertions" reads as a calm no-op and "0/0 passed" reads as a no-op that
// happens to be red; neither says the script broke.
it('chips a script that threw before asserting anything as an error, not a no-op', async () => {
  render(<ControlledResultPanel result={ok} checkResults={{ results: [], scriptError: 'boom' }} />)

  expect(screen.queryByText('no assertions')).not.toBeInTheDocument()
  expect(screen.queryByText('0/0 passed')).not.toBeInTheDocument()
  expect(screen.getByText('script error')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('boom')).toBeInTheDocument()
  expect(screen.getByLabelText('Script error')).toBeInTheDocument()
})

// `throw new Error('')` is a real failure with a falsy message; a truthiness
// check on scriptError would render it as a passing run.
it('treats an empty-message script error as an error rather than a pass', async () => {
  render(
    <ControlledResultPanel
      result={ok}
      checkResults={{
        results: [{ matcher: 'toBe' as const, actual: 200, expected: 200, pass: true }],
        scriptError: '',
      }}
    />,
  )

  // Every assertion passed, so only the script error can make this red.
  expect(screen.getByText('1/1 passed')).toHaveClass('text-destructive')

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByLabelText('Script error')).toBeInTheDocument()
})

it('shows the Trace tab\'s empty state when the result has no spans', async () => {
  const withEmptyTrace: InvokeResult = { ...ok, trace: { spans: [], pending: false } }
  render(<ResultPanel result={withEmptyTrace} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('shows the Trace tab before any invoke has happened', async () => {
  render(<ResultPanel result={null} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders captured spans in the Trace tab', async () => {
  const withSpans: InvokeResult = {
    ...ok,
    trace: {
      pending: false,
      spans: [{
        traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
        startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000', attributes: {},
      }],
    },
  }
  render(<ResultPanel result={withSpans} />)
  await userEvent.click(screen.getByText('Trace'))
  expect(screen.getByText('do-work')).toBeInTheDocument()
})

// Radix keeps the selected tab value internally, so when checkResults goes
// back to null on the next invoke the Checks trigger and content both unmount
// while "checks" stays selected — leaving the panel entirely blank.
it('falls back to the Response tab when the Checks tab disappears mid-selection', async () => {
  const { rerender } = render(<ControlledResultPanel result={ok} checkResults={mixedChecks} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))
  expect(screen.getByText('toBe(200) — actual: 200')).toBeInTheDocument()

  rerender(<ControlledResultPanel result={ok} checkResults={null} />)

  expect(screen.queryByRole('tab', { name: 'Checks' })).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('statusCode')).toBeInTheDocument()
})
