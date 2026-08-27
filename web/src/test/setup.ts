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

// jsdom has no matchMedia. Rendering `App` through a real router (the route
// test harness) ends up exercising something in the tree that reads it on
// mount — without a stub the render silently produces an empty document
// instead of the app (no thrown error to point at the cause).
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom defines window.scrollTo but only as a stub that logs "Not
// implemented" to the console — TanStack Router's scroll restoration calls
// it on every navigation. Without overriding it, each navigation in the
// route test harness logs that warning even though the navigation itself
// succeeds.
window.scrollTo = () => {}

afterEach(cleanup)
