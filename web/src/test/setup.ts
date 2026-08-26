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

// jsdom doesn't implement pointer capture or scrollIntoView, both of which
// Radix's Select touches when opening/closing — without these, clicking a
// Select trigger throws from inside Radix rather than opening the listbox.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom's Range has no getClientRects, which CodeMirror's layout measurement
// calls on every document change. Without a stub, typing into the JSON
// editor throws from deep inside CodeMirror instead of from anything the
// test did.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList
}

afterEach(cleanup)
