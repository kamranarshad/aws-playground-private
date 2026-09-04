import type { Span } from '@/lib/types'

export function spanDurationMs(span: Span): number {
  return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6
}

export function sortSpansByStart(spans: Span[]): Span[] {
  return [...spans].sort((a, b) => {
    const diff = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)
    return diff < 0n ? -1 : diff > 0n ? 1 : 0
  })
}

// Walks parentSpanId links up to the root, capped by `seen` in case of a
// cycle (malformed input shouldn't infinite-loop the UI).
export function depthOf(span: Span, byId: Map<string, Span>): number {
  let depth = 0
  let current = span
  const seen = new Set<string>()
  while (current.parentSpanId && byId.has(current.parentSpanId) && !seen.has(current.spanId)) {
    seen.add(current.spanId)
    current = byId.get(current.parentSpanId)!
    depth += 1
  }
  return depth
}

export interface LayoutRow {
  span: Span
  depth: number
}

// Sorted rows with precomputed depth, shared by every trace view so
// parent-child nesting and ordering can't drift between them.
export function layoutSpans(spans: Span[]): LayoutRow[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  return sortSpansByStart(spans).map((span) => ({ span, depth: depthOf(span, byId) }))
}

// Span names sit in one straight column in both trace views; depth is carried
// by a glyph in a fixed-width gutter beside the name, never by shifting the
// name itself. Shared for the same reason layoutSpans is: the two views each
// owned an indent formula (12 + depth*16 and depth*12), so the same name sat
// at a different x depending on which view you were in.
export const SPAN_GUTTER_PX = 12

export function spanGuideGlyph(depth: number): string {
  return depth > 0 ? '\u2514\u2500' : ''
}

export interface TimelineBounds {
  originNano: bigint
  totalMs: number
}

// The time window a waterfall spans: from the earliest span's start to the
// latest span's end, in nanoseconds/ms respectively so bar geometry only
// ever multiplies small numbers, never raw unix-nano ones.
export function timelineBounds(spans: Span[]): TimelineBounds {
  const starts = spans.map((s) => BigInt(s.startTimeUnixNano))
  const ends = spans.map((s) => BigInt(s.endTimeUnixNano))
  const originNano = starts.reduce((a, b) => (b < a ? b : a))
  const latestNano = ends.reduce((a, b) => (b > a ? b : a))
  return { originNano, totalMs: Number(latestNano - originNano) / 1e6 }
}

export function spanOffsetMs(span: Span, bounds: TimelineBounds): number {
  return Number(BigInt(span.startTimeUnixNano) - bounds.originNano) / 1e6
}

// "Nice" tick step for an axis covering `totalMs` -- picks from a 1/2/5 x
// power-of-ten sequence so labels land on round numbers instead of
// arbitrary fractions, aiming for roughly `targetTicks` marks across the
// axis.
export function niceTickStepMs(totalMs: number, targetTicks = 5): number {
  if (totalMs <= 0) return 1
  const rough = totalMs / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const residual = rough / magnitude
  const step = residual < 1.5 ? 1 : residual < 3.5 ? 2 : residual < 7.5 ? 5 : 10
  return step * magnitude
}

export function ticksFor(totalMs: number, targetTicks = 5): number[] {
  const step = niceTickStepMs(totalMs, targetTicks)
  const ticks: number[] = []
  for (let t = 0; t <= totalMs + step / 2; t += step) ticks.push(Math.round(t * 100) / 100)
  return ticks
}
