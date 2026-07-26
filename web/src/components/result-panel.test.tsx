import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'

import { ResultPanel } from '@/components/result-panel'
import type { InvokeResult } from '@/lib/types'

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
