// Nothing in the invoke pipeline stamps a log line: server/invoker.js just
// concatenates the child's stdout and stderr. So a time and a level are only
// available when the handler printed them itself, and everything here is a
// best-effort read of the front of each line.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export type LogRow =
  | { kind: 'divider'; label: string }
  | {
      kind: 'line'
      time: string | null
      level: LogLevel | null
      message: string
      // The whole parsed object, for lines that were structured JSON. The
      // viewer expands it; its presence is what makes a row expandable.
      // Undefined for plain text lines, which have nothing more to show.
      attrs?: Record<string, unknown>
      // Whatever the columns did not consume, in the order the logger wrote
      // it. Shown inline after the message, which is where the text format
      // already puts its own metadata — without this a structured line reads
      // as barer than the identical text one.
      meta?: [string, unknown][]
    }

// Both shapes capture (hh, mm, ss, fraction) in that order so one reader
// handles either. The date is non-capturing and, for the bracketed form,
// optional — `[10:23:45]` is as common as `[2026-07-30 10:23:45]`.
// ISO covers python logging's `2026-07-30 10:23:45,123` too: space for the
// separator, comma for the decimal point.
const ISO_TIME =
  /^(?:\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|[+-]\d{2}:?\d{2})?(?=\s|$)/
const BRACKET_TIME =
  /^\[(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|[+-]\d{2}:?\d{2})?\]/

// One table drives both the alternation and the mapping, so a new name can
// never go out of sync with what it maps to. Sorted longest-first before
// joining: alternation is first-match-wins left to right, and with `warn`
// ahead of `warning` in the pattern, `WARNING x` would match `warn` and
// leave `ING x` behind as the message.
const LEVELS: Record<string, LogLevel> = {
  error: 'error',
  warn: 'warn',
  warning: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'trace',
  fatal: 'error',
  critical: 'error',
}
const LEVEL_NAMES = Object.keys(LEVELS).sort((a, b) => b.length - a.length).join('|')
// Order matters: the python form has to be tried before the bare one, or
// `ERROR:root:boom` loses only `ERROR:` and keeps `root:boom` as its message.
const LEVEL_PATTERNS = [
  new RegExp(`^\\[(${LEVEL_NAMES})\\]\\s*`, 'i'),
  new RegExp(`^(${LEVEL_NAMES}):[\\w.]+:\\s*`, 'i'),
  // \b keeps `ERRORS happened` from reading as an error.
  new RegExp(`^(${LEVEL_NAMES})\\b[\\s:-]*`, 'i'),
]

// server/api.js:151 frames a two-phase run with these when a build ran.
const DIVIDER = /^=== (build|invoke) ===$/

// A continuation is output that belongs to the entry above it: an indented
// stack frame, or the header python prints before one.
const TRACEBACK_HEADER = /^Traceback \(most recent call last\):/
function isContinuation(line: string): boolean {
  return /^\s/.test(line) || TRACEBACK_HEADER.test(line)
}

// A python traceback ends with its exception line back at column 0 —
// `ValueError: boom`. Java's `Caused by: ...` does the same. Without this the
// terminator breaks out of the fold and lands as an orphan row, which is the
// exact mess folding exists to clean up.
// Deliberately narrow, and so not exhaustive: terminators not shaped like
// `<Identifier>Error`/`<Identifier>Exception` — `KeyboardInterrupt`,
// `SystemExit`, `StopIteration`, a user-defined `class Boom(Exception)`
// raised as `Boom: ...` — still orphan. Widening it would cost more in false
// folds than those cases cost as stray rows.
const EXCEPTION_LINE = /^(?:Caused by: )?[A-Za-z_][\w.]*(?:Error|Exception)\b/
// A row is mid-trace once it has absorbed a recognisable stack frame — not
// merely any indented line. An indented config dump is multi-line too, and
// without this an unrelated `TypeError: ...` printed after one would fold
// into it. The m flag is still needed: the marker doesn't always land on a
// folded line — a log opening mid-trace makes the frame the orphan row's
// first and only line, with no preceding fold to have put it there.
// A frame always carries a source location — parenthesised, or a bare
// `:line` for node's unnamed frames — and wrapped prose does not. The
// location has to end the line: a frame stops there, where prose carrying a
// clock time reads on past it, so `    at 10:30 the job started` is not a
// frame but `    at /app/h.js:10:5` is.
// This stays a heuristic. `    at the edge (see note)` is still misread as a
// frame, which is accepted: the only way to reject it is to demand digits
// inside the parens, and that would throw away java's `at Foo.bar(Native
// Method)`. A stray fold is cheaper than a dropped trace.
const TRACE_MARKER =
  /^(?:Traceback \(most recent call last\):|\s+at .*(?:\([^)]*\)|:\d+(?::\d+)?)\s*$|\s+File ".*", line \d+)/m
function isExceptionTerminator(line: string, previous: LogRow | undefined): boolean {
  return (
    EXCEPTION_LINE.test(line) &&
    previous?.kind === 'line' &&
    TRACE_MARKER.test(previous.message)
  )
}

// The column is fixed width, so pad a short fraction and drop anything past
// milliseconds rather than rounding.
function milliseconds(fraction: string | undefined): string {
  return (fraction ?? '').padEnd(3, '0').slice(0, 3)
}

function takeTime(text: string): { time: string | null; rest: string } {
  for (const pattern of [ISO_TIME, BRACKET_TIME]) {
    const m = pattern.exec(text)
    if (!m) continue
    const time = `${m[1]}:${m[2]}:${m[3]}.${milliseconds(m[4])}`
    return { time, rest: text.slice(m[0].length).trimStart() }
  }
  return { time: null, rest: text }
}

function toLevel(name: string): LogLevel {
  // The viewer has four colours, not five: LogLevel has five members, but
  // debug and trace share one muted grey rather than getting one each. The
  // LEVELS table above is what folds fatal/critical into error and warning
  // into warn, so the lookup here never needs an unchecked cast.
  return LEVELS[name.toLowerCase()]
}

function takeLevel(text: string): { level: LogLevel | null; message: string } {
  for (const pattern of LEVEL_PATTERNS) {
    const m = pattern.exec(text)
    if (!m) continue
    return { level: toLevel(m[1]), message: text.slice(m[0].length) }
  }
  return { level: null, message: text }
}

// ---- structured (JSON) lines ------------------------------------------
//
// A JSON line carries its time and level inside the object, so the readers
// above find neither and the whole entry lands as one level-less row. Which
// field holds what differs by logger, so read the common aliases rather than
// any one library's names. First match wins, most specific first.
const TIME_KEYS = ['timestamp', 'time', '@timestamp', 'ts', 'date']
const LEVEL_KEYS = ['level', 'status', 'severity', 'levelname', 'loglevel']
const MESSAGE_KEYS = ['message', 'msg', 'event', 'short_message']

// Returns the key as well as the value: the caller has to know which field it
// consumed, so the rest can be listed as metadata without repeating it.
function pick(
  obj: Record<string, unknown>, keys: string[],
): { key: string; value: unknown } | null {
  for (const key of keys) if (obj[key] != null) return { key, value: obj[key] }
  return null
}

// pino and bunyan number their levels on the same scale. Ranges rather than
// exact matches, so a custom level sitting between the standard steps still
// lands somewhere sensible instead of nowhere.
function numericLevel(value: number): LogLevel {
  if (value < 20) return 'trace'
  if (value < 30) return 'debug'
  if (value < 40) return 'info'
  if (value < 50) return 'warn'
  return 'error'
}

function structuredLevel(value: unknown): LogLevel | null {
  if (typeof value === 'number') return numericLevel(value)
  if (typeof value !== 'string') return null
  // Some transports write pino's numeric level back out as a string.
  const numeric = Number(value)
  if (value.trim() !== '' && Number.isFinite(numeric)) return numericLevel(numeric)
  return LEVELS[value.toLowerCase()] ?? null
}

// pino stamps Date.now(); other loggers use whole seconds. Below the
// threshold is read as seconds: 1e11 milliseconds is 1973 and 1e11 seconds is
// the year 5138, so no real log is ambiguous.
function fromEpoch(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const date = new Date(value < 1e11 ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return null
  // UTC, which is how an ISO string ending in Z already renders above.
  return date.toISOString().slice(11, 23)
}

function structuredTime(value: unknown): string | null {
  if (typeof value === 'number') return fromEpoch(value)
  if (typeof value !== 'string') return null
  const numeric = Number(value)
  if (value.trim() !== '' && Number.isFinite(numeric)) return fromEpoch(numeric)
  // Reuse the text readers: a JSON timestamp is usually just an ISO string.
  return takeTime(value).time
}

function parseStructured(line: string): LogRow | null {
  if (!line.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const messageField = pick(obj, MESSAGE_KEYS)
  const levelField = pick(obj, LEVEL_KEYS)
  const timeField = pick(obj, TIME_KEYS)
  const level = levelField && structuredLevel(levelField.value)
  const time = timeField && structuredTime(timeField.value)
  // A handler printing plain data is not a log entry. Requiring a message, or
  // a level that actually resolves to one we know, keeps `{"statusCode":200}`
  // and `{"status":"ok"}` rendering as the raw JSON they are — `status` is a
  // level key, but `"ok"` is not a level.
  if (!messageField && !level) return null

  const raw = messageField?.value
  const message = raw === undefined
    ? ''
    : typeof raw === 'string' ? raw : JSON.stringify(raw)

  // Only a field that actually resolved counts as consumed. A `timestamp`
  // that didn't parse stays in the metadata rather than vanishing, so a
  // malformed value is visible instead of silently dropped.
  const consumed = new Set<string>()
  if (messageField) consumed.add(messageField.key)
  if (level && levelField) consumed.add(levelField.key)
  if (time && timeField) consumed.add(timeField.key)

  return {
    kind: 'line',
    time: time ?? null,
    level: level ?? null,
    message,
    attrs: obj,
    meta: Object.entries(obj).filter(([key]) => !consumed.has(key)),
  }
}

export function parseLogs(raw: string): LogRow[] {
  const lines = raw.split('\n')
  // Child output ends with a newline, which split turns into a phantom
  // trailing entry. One only: blank lines the handler meant are its own.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  const rows: LogRow[] = []
  for (const line of lines) {
    // A blank line would render as an empty bordered row, which reads as a
    // glitch. Whitespace-only lines are not blank — they fold below, but
    // only when there is a row above them to fold into (see below).
    if (line === '') continue

    const divider = DIVIDER.exec(line)
    if (divider) {
      rows.push({ kind: 'divider', label: divider[1] })
      continue
    }

    const previous = rows[rows.length - 1]
    // This has to sit below the `previous` lookup, since it depends on it.
    // With no line row above to fold into, a whitespace-only line would
    // otherwise fall through to a row of its own — the same empty bordered
    // row the blank-line drop above exists to prevent.
    if (line.trim() === '' && previous?.kind !== 'line') continue
    if (
      (isContinuation(line) || isExceptionTerminator(line, previous)) &&
      previous?.kind === 'line'
    ) {
      previous.message += `\n${line}`
      continue
    }

    // Structured first: a JSON line starts with `{`, so the text readers
    // below would find no leading time or level and hand back the whole
    // object as one level-less message.
    const structured = parseStructured(line)
    if (structured) {
      rows.push(structured)
      continue
    }

    const { time, rest } = takeTime(line)
    const { level, message } = takeLevel(rest)
    rows.push({ kind: 'line', time, level, message })
  }
  return rows
}
