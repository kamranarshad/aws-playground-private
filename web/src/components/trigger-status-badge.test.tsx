import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TriggerStatusBadge } from '@/components/trigger-status-badge'

it('shows the polling state', () => {
  render(<TriggerStatusBadge status={{ state: 'polling', lastError: null, lastPolledAt: 123 }} />)
  expect(screen.getByText('Trigger: polling')).toBeInTheDocument()
})

it('shows the error state with the message in a title attribute', () => {
  render(<TriggerStatusBadge status={{ state: 'error', lastError: 'connection refused', lastPolledAt: null }} />)
  const badge = screen.getByText('Trigger: error')
  expect(badge).toHaveAttribute('title', 'connection refused')
})
