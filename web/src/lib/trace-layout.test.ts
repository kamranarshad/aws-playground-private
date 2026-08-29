import { expect, it } from 'vitest'
import {
  depthOf, layoutSpans, niceTickStepMs, spanDurationMs, spanOffsetMs, ticksFor, timelineBounds,
} from '@/lib/trace-layout'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'root-span',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

it('spanDurationMs computes the ms difference from nanosecond strings', () => {
  expect(spanDurationMs(span({ startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000' }))).toBe(5)
})

it('depthOf walks parentSpanId links up to the root', () => {
  const root = span({ spanId: 'root', parentSpanId: null })
  const mid = span({ spanId: 'mid', parentSpanId: 'root' })
  const leaf = span({ spanId: 'leaf', parentSpanId: 'mid' })
  const byId = new Map([root, mid, leaf].map((s) => [s.spanId, s]))
  expect(depthOf(root, byId)).toBe(0)
  expect(depthOf(mid, byId)).toBe(1)
  expect(depthOf(leaf, byId)).toBe(2)
})

it('depthOf terminates on a cycle instead of looping forever', () => {
  const a = span({ spanId: 'a', parentSpanId: 'b' })
  const b = span({ spanId: 'b', parentSpanId: 'a' })
  const byId = new Map([a, b].map((s) => [s.spanId, s]))
  expect(depthOf(a, byId)).toBe(2)
})

it('layoutSpans sorts by start time and attaches each span\'s depth', () => {
  const parent = span({ spanId: 'p', name: 'parent', startTimeUnixNano: '2000000000', endTimeUnixNano: '2010000000' })
  const child = span({
    spanId: 'c', parentSpanId: 'p', name: 'child', startTimeUnixNano: '1000000000', endTimeUnixNano: '1002000000',
  })
  const rows = layoutSpans([parent, child])
  expect(rows.map((r) => r.span.name)).toEqual(['child', 'parent'])
  expect(rows.find((r) => r.span.name === 'child')?.depth).toBe(1)
  expect(rows.find((r) => r.span.name === 'parent')?.depth).toBe(0)
})

it('timelineBounds spans from the earliest start to the latest end', () => {
  const a = span({ startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000' })
  const b = span({ startTimeUnixNano: '1002000000', endTimeUnixNano: '1020000000' })
  const bounds = timelineBounds([a, b])
  expect(bounds.originNano).toBe(1000000000n)
  expect(bounds.totalMs).toBe(20)
})

it('spanOffsetMs is the span\'s start relative to the timeline origin', () => {
  const bounds = { originNano: 1000000000n, totalMs: 20 }
  expect(spanOffsetMs(span({ startTimeUnixNano: '1005000000' }), bounds)).toBe(5)
})

it('niceTickStepMs picks a round step from the 1/2/5 sequence', () => {
  expect(niceTickStepMs(50)).toBe(10)
  expect(niceTickStepMs(23)).toBe(5)
  expect(niceTickStepMs(9)).toBe(2)
})

it('ticksFor generates evenly spaced round ticks covering the total duration', () => {
  expect(ticksFor(20)).toEqual([0, 5, 10, 15, 20])
})

it('ticksFor never divides by zero for a zero-duration trace', () => {
  expect(ticksFor(0)).toEqual([0])
})
