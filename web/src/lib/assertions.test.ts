import { expect, it } from 'vitest'
import { runAssertions } from '@/lib/assertions'

const ctx = { response: undefined, error: null, report: null }

it('passes toBe when values are strictly equal', () => {
  const { results, scriptError } = runAssertions('expect(200).toBe(200)', ctx)
  expect(scriptError).toBeNull()
  expect(results).toEqual([{ matcher: 'toBe', actual: 200, expected: 200, pass: true }])
})

it('fails toBe when values differ', () => {
  const { results } = runAssertions('expect(404).toBe(200)', ctx)
  expect(results).toEqual([{ matcher: 'toBe', actual: 404, expected: 200, pass: false }])
})

it('passes toEqual for deeply equal objects regardless of key order', () => {
  const { results } = runAssertions('expect({ a: 1, b: [1, 2] }).toEqual({ b: [1, 2], a: 1 })', ctx)
  expect(results[0].pass).toBe(true)
})

it('fails toEqual for objects that differ', () => {
  const { results } = runAssertions('expect({ a: 1 }).toEqual({ a: 2 })', ctx)
  expect(results[0].pass).toBe(false)
})

it('passes toContain for a substring', () => {
  const { results } = runAssertions('expect("hello world").toContain("world")', ctx)
  expect(results[0].pass).toBe(true)
})

it('passes toContain for an array element', () => {
  const { results } = runAssertions('expect([1, 2, 3]).toContain(2)', ctx)
  expect(results[0].pass).toBe(true)
})

it('fails toContain gracefully when actual is neither a string nor an array', () => {
  const { results } = runAssertions('expect(200).toContain(2)', ctx)
  expect(results[0]).toEqual({
    matcher: 'toContain', actual: 200, expected: 'toContain requires a string or array', pass: false,
  })
})

it('passes toMatch against a regex', () => {
  const { results } = runAssertions('expect("order-123").toMatch(/^order-\\d+$/)', ctx)
  expect(results[0].pass).toBe(true)
})

it('passes toMatch against a string pattern', () => {
  const { results } = runAssertions('expect("order-123").toMatch("order-\\\\d+")', ctx)
  expect(results[0].pass).toBe(true)
})

it('runs every expect() even after an earlier one fails', () => {
  const { results } = runAssertions('expect(1).toBe(2); expect(1).toBe(1)', ctx)
  expect(results.map((r) => r.pass)).toEqual([false, true])
})

it('keeps results recorded before a thrown error, and reports the error message', () => {
  const { results, scriptError } = runAssertions(
    'expect(1).toBe(1); response.nonexistent.deeper',
    ctx,
  )
  expect(results).toEqual([{ matcher: 'toBe', actual: 1, expected: 1, pass: true }])
  expect(scriptError).toMatch(/nonexistent/)
})

it('reports a syntax error as scriptError with no results', () => {
  const { results, scriptError } = runAssertions('expect(1).toBe(', ctx)
  expect(results).toEqual([])
  expect(scriptError).not.toBeNull()
})

it('returns empty results and no error for an empty script', () => {
  const { results, scriptError } = runAssertions('', ctx)
  expect(results).toEqual([])
  expect(scriptError).toBeNull()
})

it('exposes response, error, and report to the script', () => {
  const { results } = runAssertions(
    'expect(response.statusCode).toBe(200); expect(report.durationMs).toBe(12)',
    {
      response: { statusCode: 200 },
      error: null,
      report: { requestId: 'r1', durationMs: 12, billedMs: 13, memoryMb: 128, timedOut: false },
    },
  )
  expect(results.every((r) => r.pass)).toBe(true)
})
