import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { CopyableValue } from '@/components/copyable-value'
import { toast } from 'sonner'

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) }, configurable: true,
  })
  return window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>
}

afterEach(() => vi.clearAllMocks())

it('copies its value to the clipboard', async () => {
  const writeText = stubClipboard(async () => {})
  render(<CopyableValue value="playground123" />)

  await userEvent.click(screen.getByLabelText('Copy playground123'))

  expect(writeText).toHaveBeenCalledWith('playground123')
})

it('confirms with a checkmark, then goes back to the copy icon', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  stubClipboard(async () => {})
  render(<CopyableValue value="secret" />)
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

  await user.click(screen.getByLabelText('Copy secret'))
  expect(screen.getByRole('button').querySelector('.text-emerald-500')).toBeTruthy()

  await act(() => vi.advanceTimersByTimeAsync(1300))
  expect(screen.getByRole('button').querySelector('.text-emerald-500')).toBeNull()
  vi.useRealTimers()
})

// Headless browsers and non-secure contexts refuse clipboard writes. Showing
// a checkmark there would claim a copy that never happened.
it('reports a failed copy instead of pretending it worked', async () => {
  stubClipboard(async () => { throw new Error('denied') })
  render(<CopyableValue value="nope" />)

  await userEvent.click(screen.getByLabelText('Copy nope'))

  expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard')
  expect(screen.getByRole('button').querySelector('.text-emerald-500')).toBeNull()
})
