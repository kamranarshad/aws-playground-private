import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has no ResizeObserver, and Radix's ScrollArea constructs one in a
// layout effect. It only bites on re-render — the first paint of a scroll
// area is fine — so any test that clicks something inside one throws
// "ResizeObserver is not defined" from deep in Radix rather than from
// anything the test did. A no-op stub is enough: nothing here asserts on
// measured sizes, which jsdom reports as zero regardless.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

afterEach(cleanup)
