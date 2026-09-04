import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useLayout } from '@/lib/use-layout'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

it('defaults to the side-by-side split', () => {
  const { result } = renderHook(() => useLayout())
  expect(result.current.layout).toBe('split')
})

it('toggles between split and stacked', () => {
  const { result } = renderHook(() => useLayout())
  act(() => result.current.toggle())
  expect(result.current.layout).toBe('stacked')
  act(() => result.current.toggle())
  expect(result.current.layout).toBe('split')
})

it('restores the stored choice on a later mount', () => {
  const first = renderHook(() => useLayout())
  act(() => first.result.current.toggle())
  first.unmount()

  const { result } = renderHook(() => useLayout())
  expect(result.current.layout).toBe('stacked')
})

it('ignores an unrecognized stored value', () => {
  localStorage.setItem('awsplay-layout', 'diagonal')
  const { result } = renderHook(() => useLayout())
  expect(result.current.layout).toBe('split')
})

// Private-mode browsers throw on both reads and writes. Losing the
// preference is fine; taking the page down with it is not.
it('survives a localStorage that throws on read and on write', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })

  const { result } = renderHook(() => useLayout())
  expect(result.current.layout).toBe('split')
  expect(() => act(() => result.current.toggle())).not.toThrow()
  expect(result.current.layout).toBe('stacked')
})
