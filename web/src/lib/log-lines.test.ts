import { expect, it } from 'vitest'
import { parseLogs, type LogRow } from '@/lib/log-lines'

// Divider rows are asserted separately; narrowing to `line` rows here keeps
// the assertions below readable. The predicate is written out rather than
// left to inference so `rows[0].message` typechecks regardless of TS version.
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

// Guards the longest-first sort feeding the alternation: with `warn` tried
// before `warning`, this would match `warn` and leave `ING slow query`
// behind as the message.
it('does not let WARN swallow the ING of WARNING', () => {
  expect(lines('WARNING slow query')[0]).toMatchObject({ level: 'warn', message: 'slow query' })
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

// A whitespace-only line is not blank, but with no line row above it to
// fold into it would fall through to the same empty bordered row a bare
// blank line renders as — the glitch the blank-line drop exists to prevent.
it('drops a whitespace-only line with no line above it to fold into', () => {
  expect(parseLogs('   \n')).toEqual([])
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
// follows an unrelated log line — only a row already holding a stack trace
// is a valid fold target.
it('does not fold a standalone exception line into an unrelated line above it', () => {
  const rows = lines('hello from the handler\nValueError: bad input\n')

  expect(rows).toHaveLength(2)
  expect(rows[1]).toEqual({
    kind: 'line', time: null, level: null, message: 'ValueError: bad input',
  })
})

// Being multi-line is not the same as being a stack trace: an indented
// config dump absorbs continuations too. Only a row holding a recognisable
// stack frame is a fold target, or an unrelated exception printed after a
// dump gets silently swallowed into it.
it('does not fold an exception line into a multi-line row that is not a trace', () => {
  const rows = lines(
    'INFO listing config:\n  key: value\n  another: value\nTypeError: not related at all\n',
  )

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    level: 'info', message: 'listing config:\n  key: value\n  another: value',
  })
  expect(rows[1]).toEqual({
    kind: 'line', time: null, level: null, message: 'TypeError: not related at all',
  })
})

// "at least", "at approximately", "at position X" all open a wrapped line
// of ordinary prose. Indented, such a line folds like any continuation, and
// unless a frame is required to carry a source location that folded prose
// makes its row look mid-trace and lets an unrelated exception in behind it.
it('does not treat indented prose beginning "at " as a stack frame', () => {
  const rows = lines(
    'INFO handler retrying:\n    at least three retries remain\nTypeError: not related\n',
  )

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    level: 'info', message: 'handler retrying:\n    at least three retries remain',
  })
  expect(rows[1]).toEqual({
    kind: 'line', time: null, level: null, message: 'TypeError: not related',
  })
})

// Node prints a frame with no parentheses when there is no function to name.
// The `:line:col` suffix is all that marks it as a frame, so this is what
// stops a later tightening of the rule from quietly dropping the bare form.
it('folds an exception line into a node frame with no parentheses', () => {
  const rows = lines('ERROR boom\n    at /app/handler.js:10:5\nTypeError: inner\n')

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe('boom\n    at /app/handler.js:10:5\nTypeError: inner')
})

// A clock time in wrapped prose looks like a frame's `:line` suffix. What
// separates them is position: a frame ends at its location, prose carries on
// past it.
it('does not treat a clock time in indented prose as a frame location', () => {
  const rows = lines(
    'INFO job scheduled:\n    at 10:30 the job started\nTypeError: not related\n',
  )

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    level: 'info', message: 'job scheduled:\n    at 10:30 the job started',
  })
  expect(rows[1]).toEqual({
    kind: 'line', time: null, level: null, message: 'TypeError: not related',
  })
})

// Java reports a chained exception with `Caused by: ...`, back at column 0,
// the same way python's terminator line is — over both frame forms it can
// follow. `Native Method` is the load-bearing case: it names a source with
// no line number at all, and nothing inside its parens is numeric, so it's
// what rules out ever demanding digits there.
it.each([
  ['a numbered frame', 'at Handler.run(Handler.java:12)'],
  ['a frame with no digits in its parens', 'at Foo.bar(Native Method)'],
])('folds a java "Caused by" line into the trace above it, over %s', (_, frame) => {
  const rows = lines(`ERROR boom\n\t${frame}\nCaused by: java.lang.RuntimeException: inner\n`)

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe(`boom\n\t${frame}\nCaused by: java.lang.RuntimeException: inner`)
})

// Captured verbatim from a real invoke of fixtures/typescript/winston-datadog,
// the way the python capture above was. Hand-written fixtures kept agreeing
// with whatever the parser already did; captures are what caught the bugs.
// This one pins the node/winston shape: an ISO timestamp and a padded level
// per line, a bare console.log carrying neither, and a stack printed as
// frames only so the whole failure stays one row.
it('parses a real winston capture into one row per entry', () => {
  const rows = lines(
    '2026-07-31T02:30:55.887Z DEBUG payload parsed  format=text\n' +
    '2026-07-31T02:30:55.889Z INFO  fetching order  order_id=A-1001\n' +
    '2026-07-31T02:30:55.889Z WARN  slow downstream call  order_id=A-1001 duration_ms=812\n' +
    'plain console.log - no level, no timestamp\n' +
    '2026-07-31T02:30:55.889Z ERROR order lookup failed  order_id=A-1001 errorKind=RangeError\n' +
    '    at readFromStore (/app/dist/index.js:10806:9)\n' +
    '    at lookupOrder (/app/dist/index.js:10809:10)\n' +
    '    at new Promise (<anonymous>)\n' +
    '2026-07-31T02:30:55.890Z INFO  handler complete  order_id=A-1001\n',
  )

  expect(rows.map((r) => r.level)).toEqual([
    'debug', 'info', 'warn', null, 'error', 'info',
  ])
  expect(rows.map((r) => r.time)).toEqual([
    '02:30:55.887', '02:30:55.889', '02:30:55.889', null, '02:30:55.889', '02:30:55.890',
  ])
  // The three frames land in the error row, not in rows of their own.
  expect(rows[4].message.split('\n')).toHaveLength(4)
  expect(rows[4].message).toContain('at new Promise (<anonymous>)')
  // `at new Promise (<anonymous>)` has no line:col — the parenthesised source
  // is what keeps it readable as a frame.
  expect(rows[5].message).toBe('handler complete  order_id=A-1001')
})
