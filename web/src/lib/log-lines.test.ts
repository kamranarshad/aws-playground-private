import { expect, it } from 'vitest'
import { parseLogs, type LogRow } from '@/lib/log-lines'

// Only `line` rows exist until Task 2 adds dividers; narrowing here keeps the
// assertions readable. The predicate is written out rather than left to
// inference so `rows[0].message` typechecks regardless of TS version.
function lines(raw: string) {
  return parseLogs(raw).filter(
    (r): r is Extract<LogRow, { kind: 'line' }> => r.kind === 'line',
  )
}

it('returns nothing for empty input', () => {
  expect(parseLogs('')).toEqual([])
})

// Child output ends with a newline; that trailing empty string is not a log line.
it('ignores the trailing newline the runtime emits', () => {
  expect(lines('one\ntwo\n')).toHaveLength(2)
})

it('keeps an unadorned line whole, with no time and no level', () => {
  expect(lines('hello from the handler')).toEqual([
    { kind: 'line', time: null, level: null, message: 'hello from the handler' },
  ])
})

it.each([
  ['2026-07-30T10:23:45.123Z boot', '10:23:45.123', 'boot'],
  ['2026-07-30T10:23:45Z boot', '10:23:45.000', 'boot'],
  ['2026-07-30T10:23:45.123+02:00 boot', '10:23:45.123', 'boot'],
  ['2026-07-30 10:23:45,123 boot', '10:23:45.123', 'boot'],
  ['[10:23:45] boot', '10:23:45.000', 'boot'],
  ['[10:23:45.123] boot', '10:23:45.123', 'boot'],
  ['[2026-07-30 10:23:45] boot', '10:23:45.000', 'boot'],
])('pulls the time out of %s', (raw, time, message) => {
  expect(lines(raw)[0]).toMatchObject({ time, message })
})

// Sub-millisecond precision is truncated, not rounded — the column is fixed width.
it('truncates microsecond precision to milliseconds', () => {
  expect(lines('2026-07-30T10:23:45.123456Z boot')[0]).toMatchObject({ time: '10:23:45.123' })
})

it('leaves a date with no time of day in the message', () => {
  expect(lines('2026-07-30 shipped')[0]).toMatchObject({
    time: null, message: '2026-07-30 shipped',
  })
})

it.each([
  ['ERROR connection refused', 'error', 'connection refused'],
  ['ERROR: connection refused', 'error', 'connection refused'],
  ['[ERROR] connection refused', 'error', 'connection refused'],
  ['ERROR:root:connection refused', 'error', 'connection refused'],
  ['WARNING slow query', 'warn', 'slow query'],
  ['WARN slow query', 'warn', 'slow query'],
  ['info listening', 'info', 'listening'],
  ['DEBUG payload parsed', 'debug', 'payload parsed'],
  ['TRACE entering handler', 'trace', 'entering handler'],
])('pulls the level out of %s', (raw, level, message) => {
  expect(lines(raw)[0]).toMatchObject({ level, message })
})

// FATAL and CRITICAL are error by another name; the viewer has no fifth colour.
it.each(['FATAL out of memory', 'CRITICAL out of memory'])('treats %s as an error', (raw) => {
  expect(lines(raw)[0]).toMatchObject({ level: 'error', message: 'out of memory' })
})

// Anchored to the start, so prose that merely mentions a level is left alone.
it.each([
  'no error found',
  'the info you asked for',
  'ERRORS happened',
])('does not take a level out of %s', (raw) => {
  expect(lines(raw)[0]).toMatchObject({ level: null, message: raw })
})

it('reads a time and a level off the same line', () => {
  expect(lines('2026-07-30 10:23:45,123 ERROR:root:boom')[0]).toEqual({
    kind: 'line', time: '10:23:45.123', level: 'error', message: 'boom',
  })
})

// server/api.js:151 prepends these when a build ran.
it('turns the build and invoke markers into dividers', () => {
  const rows = parseLogs('=== build ===\ntsc ok\n=== invoke ===\nhello\n')

  expect(rows).toEqual([
    { kind: 'divider', label: 'build' },
    { kind: 'line', time: null, level: null, message: 'tsc ok' },
    { kind: 'divider', label: 'invoke' },
    { kind: 'line', time: null, level: null, message: 'hello' },
  ])
})

// The whole point of the tidy-up: a traceback is one entry, not a dozen
// level-less rows trailing after the line that explains them.
it('folds an indented traceback into the line above it', () => {
  const rows = lines(
    'ERROR boom\nTraceback (most recent call last):\n  File "h.py", line 3\n    raise ValueError\n',
  )

  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual({
    kind: 'line',
    time: null,
    level: 'error',
    message: 'boom\nTraceback (most recent call last):\n  File "h.py", line 3\n    raise ValueError',
  })
})

it('folds a java stack frame into the line above it', () => {
  const rows = lines('ERROR boom\n\tat Handler.run(Handler.java:12)\n')

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe('boom\n\tat Handler.run(Handler.java:12)')
})

// Logs that open mid-trace have nothing to fold into; the line is still content.
it('keeps a continuation with no line above it as its own row', () => {
  expect(lines('  File "h.py", line 3\n')).toEqual([
    { kind: 'line', time: null, level: null, message: '  File "h.py", line 3' },
  ])
})

// A divider is not a fold target — a trace cannot continue across a phase.
it('does not fold a continuation into a divider', () => {
  const rows = parseLogs('=== invoke ===\n  indented first line\n')

  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({ kind: 'line', message: '  indented first line' })
})

// A bare blank line would render as an empty bordered row, which reads as a
// glitch rather than as spacing.
it('drops blank lines between entries', () => {
  expect(lines('one\n\n\ntwo\n')).toHaveLength(2)
})

// ...but a blank line inside a trace is part of it, and is indented or folded
// by position, so it survives as part of the parent message.
it('keeps a whitespace-only line inside a folded trace', () => {
  const rows = lines('ERROR boom\n  File "h.py", line 3\n   \n')

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe('boom\n  File "h.py", line 3\n   ')
})

// Captured verbatim from a real python handler invocation: the exception
// line that ends the traceback sits back at column 0, so without a
// terminator rule it breaks out of the fold and lands as its own orphan row
// between the trace and the CRITICAL line that follows.
it('folds the terminating exception line of a real python traceback', () => {
  const rows = lines(
    [
      'DEBUG:root:payload parsed',
      'INFO:root:listening on the local endpoint',
      'WARNING:root:slow query took 812ms',
      'a bare print with no level at all',
      'ERROR:root:handler blew up',
      'Traceback (most recent call last):',
      '  File "/private/tmp/logviewer-check/handler.py", line 12, in handler',
      '    raise ValueError("boom from python")',
      'ValueError: boom from python',
      'CRITICAL:root:out of memory',
      '',
    ].join('\n'),
  )

  expect(rows).toHaveLength(6)
  expect(rows.map((r) => r.level)).toEqual(['debug', 'info', 'warn', null, 'error', 'error'])
  expect(rows[4].message).toBe(
    'handler blew up\n' +
      'Traceback (most recent call last):\n' +
      '  File "/private/tmp/logviewer-check/handler.py", line 12, in handler\n' +
      '    raise ValueError("boom from python")\n' +
      'ValueError: boom from python',
  )
  expect(rows[5]).toMatchObject({ level: 'error', message: 'out of memory' })
})

// The terminator rule must not swallow an exception line that merely
// follows an unrelated log line — only a row already mid-trace (its message
// already holds a folded continuation) is a valid fold target.
it('does not fold a standalone exception line into an unrelated line above it', () => {
  const rows = lines('hello from the handler\nValueError: bad input\n')

  expect(rows).toHaveLength(2)
  expect(rows[1]).toEqual({
    kind: 'line', time: null, level: null, message: 'ValueError: bad input',
  })
})

// Java reports a chained exception with `Caused by: ...`, back at column
// 0, the same way python's terminator line is.
it('folds a java "Caused by" line into the trace above it', () => {
  const rows = lines(
    'ERROR boom\n\tat Handler.run(Handler.java:12)\nCaused by: java.lang.RuntimeException: inner\n',
  )

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe(
    'boom\n\tat Handler.run(Handler.java:12)\nCaused by: java.lang.RuntimeException: inner',
  )
})
