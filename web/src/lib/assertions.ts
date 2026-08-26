import type { CheckResult, LambdaError, Report } from '@/lib/types'

interface AssertionContext {
  response: unknown
  error: LambdaError | null | undefined
  report: Report | null
}

export interface AssertionRun {
  results: CheckResult[]
  scriptError: string | null
}

function deepEqual(a: unknown, b: unknown): boolean {
  // NaN-safe: NaN !== NaN, so an expected NaN would never match without this.
  // Kept separate from === (rather than folded into Object.is) so 0 and -0
  // still compare equal, which is what a JSON-shaped payload expects.
  if (a !== a && b !== b) return true
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // An array and a plain object can have identical enumerable keys ([1,2] vs
  // {0:1,1:2}); they are not the same value.
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

export function runAssertions(script: string, ctx: AssertionContext): AssertionRun {
  const results: CheckResult[] = []

  function record(matcher: CheckResult['matcher'], actual: unknown, expected: unknown, pass: boolean) {
    results.push({ matcher, actual, expected, pass })
  }

  function expect(actual: unknown) {
    return {
      toBe(expected: unknown) {
        record('toBe', actual, expected, actual === expected)
      },
      toEqual(expected: unknown) {
        record('toEqual', actual, expected, deepEqual(actual, expected))
      },
      toContain(expected: unknown) {
        // Branch on `actual` first: the failure message below is about
        // `actual`'s type, so a string body checked against a non-string
        // needle (toContain(123)) is a substring search for "123", not a
        // "requires a string or array" error.
        if (typeof actual === 'string') {
          record('toContain', actual, expected, actual.includes(String(expected)))
        } else if (Array.isArray(actual)) {
          record('toContain', actual, expected, actual.includes(expected))
        } else {
          record('toContain', actual, 'toContain requires a string or array', false)
        }
      },
      toMatch(pattern: RegExp | string) {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern)
        // The regex's source form, not the object: JSON.stringify(/x/) is "{}",
        // which makes a failing row read `toMatch({})` in the Checks list.
        record('toMatch', actual, String(regex), regex.test(String(actual)))
      },
    }
  }

  try {
    // This evaluates the user's script in the browser tab, not in a sandboxed
    // process: it has ambient access to this origin (fetch against the local
    // control API, localStorage, the DOM). That is acceptable for a
    // single-developer localhost tool where you author your own scripts and
    // execution is gated behind an explicit button press — it is not a
    // security boundary, so never run a script you did not write.
    // 'use strict' so an undeclared assignment throws instead of quietly
    // creating a global.
    const run = new Function('response', 'error', 'report', 'expect', `'use strict';\n${script}`) as
      (response: unknown, error: unknown, report: unknown, expect: unknown) => void
    run(ctx.response, ctx.error, ctx.report, expect)
    return { results, scriptError: null }
  } catch (e) {
    // Not an unchecked cast: `throw 'nope'` and `throw new Error('')` both
    // yield a falsy message, which downstream would read as "no error".
    return { results, scriptError: e instanceof Error ? (e.message || '(no message)') : String(e) }
  }
}
