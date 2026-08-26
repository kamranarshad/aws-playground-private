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
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
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
        if (typeof actual === 'string' && typeof expected === 'string') {
          record('toContain', actual, expected, actual.includes(expected))
        } else if (Array.isArray(actual)) {
          record('toContain', actual, expected, actual.includes(expected))
        } else {
          record('toContain', actual, 'toContain requires a string or array', false)
        }
      },
      toMatch(pattern: RegExp | string) {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern)
        record('toMatch', actual, pattern, regex.test(String(actual)))
      },
    }
  }

  try {
    const run = new Function('response', 'error', 'report', 'expect', script) as
      (response: unknown, error: unknown, report: unknown, expect: unknown) => void
    run(ctx.response, ctx.error, ctx.report, expect)
    return { results, scriptError: null }
  } catch (e) {
    return { results, scriptError: (e as Error).message }
  }
}
