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

// NaN !== NaN, so the naive === would report a NaN field as unequal to itself.
it('passes toEqual for NaN against NaN', () => {
  const { results, scriptError } = runAssertions('expect(NaN).toEqual(NaN)', ctx)
  expect(scriptError).toBeNull()
  expect(results[0].pass).toBe(true)
})

// An array and an object can share every enumerable key and still not be the
// same value; comparing keys alone would call these equal.
it('fails toEqual for an array against an object with the same index keys', () => {
  const { results } = runAssertions('expect([1, 2]).toEqual({ 0: 1, 1: 2 })', ctx)
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

// The "requires a string or array" message is about `actual`, so a string body
// searched for a number is a substring search, not a type complaint.
it('coerces a non-string needle when actual is a string', () => {
  const { results } = runAssertions('expect("order-123").toContain(123)', ctx)
  expect(results[0]).toEqual({ matcher: 'toContain', actual: 'order-123', expected: 123, pass: true })
})

it('passes toMatch against a regex', () => {
  const { results } = runAssertions('expect("order-123").toMatch(/^order-\\d+$/)', ctx)
  expect(results[0].pass).toBe(true)
})

// JSON.stringify(/x/) is "{}", so storing the object itself made a failing row
// read `toMatch({}) — actual: "nope"` in the Checks list.
it('records a regex pattern in readable string form', () => {
  const { results } = runAssertions('expect("nope").toMatch(/^order-\\d+$/)', ctx)
  expect(results[0].pass).toBe(false)
  expect(results[0].expected).toBe('/^order-\\d+$/')
  expect(results[0].expected).not.toBeInstanceOf(RegExp)
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

// `(e as Error).message` on a thrown string is undefined — falsy, so the panel
// rendered a script that threw as a calm "no assertions" run.
it('reports a thrown non-Error value as scriptError', () => {
  const { scriptError } = runAssertions('throw "plain string"', ctx)
  expect(scriptError).toBe('plain string')
})

it('reports a thrown Error with an empty message as a non-empty scriptError', () => {
  const { scriptError } = runAssertions('throw new Error("")', ctx)
  expect(scriptError).toBe('(no message)')
})

// Strict mode: an accidental `x = 1` should throw rather than quietly creating
// a global on window.
it('reports an undeclared assignment as a script error', () => {
  const { scriptError } = runAssertions('someUndeclared = 1', ctx)
  expect(scriptError).toMatch(/someUndeclared/)
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
