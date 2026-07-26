import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    listServices: vi.fn().mockResolvedValue({
      docker: { available: true },
      services: [],
    }),
  },
}))

import { api } from '@/lib/api'
import { useReleaseSelectionOnUnload, useServices } from '@/lib/queries'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('polls the services list so containers stopped outside the UI stop showing as running', async () => {
  vi.useFakeTimers()
  renderHook(() => useServices(), { wrapper: makeWrapper() })

  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(api.listServices).toHaveBeenCalledTimes(1)

  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(api.listServices).toHaveBeenCalledTimes(2)
})

it('releases the selection when the page closes, so auto-started services get reaped', async () => {
  const sendBeacon = vi.fn(() => true)
  Object.defineProperty(window.navigator, 'sendBeacon', {
    value: sendBeacon, configurable: true, writable: true,
  })

  renderHook(() => useReleaseSelectionOnUnload())
  window.dispatchEvent(new Event('beforeunload'))

  expect(sendBeacon).toHaveBeenCalledTimes(1)
  const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob]
  expect(url).toBe('/api/selection')
  // jsdom's Blob predates .text() and isn't recognised by undici's Response.
  const body = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  expect(JSON.parse(body)).toEqual({ functionId: null })
  expect(blob.type).toBe('application/json')
})

it('stops releasing the selection once unmounted', () => {
  const sendBeacon = vi.fn(() => true)
  Object.defineProperty(window.navigator, 'sendBeacon', {
    value: sendBeacon, configurable: true, writable: true,
  })

  const { unmount } = renderHook(() => useReleaseSelectionOnUnload())
  unmount()
  window.dispatchEvent(new Event('beforeunload'))

  expect(sendBeacon).not.toHaveBeenCalled()
})
