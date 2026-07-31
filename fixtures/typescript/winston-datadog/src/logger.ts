// Winston wired up two ways, so one fixture covers both halves of "Datadog
// format". JSON is what Datadog's intake prefers and what most Node services
// actually emit; text is what a grok pipeline reads, and the only one of the
// two the playground's Logs tab can parse. Shipping both is deliberate: it
// exercises the viewer AND shows what structured logs currently look like in
// it (a column of level-less rows).
import { createLogger as winstonLogger, format, transports, type Logger } from 'winston'

export type LogFormat = 'text' | 'json'

const SERVICE = 'orders-api'

// Datadog's standard attributes, so the JSON shape is the real thing rather
// than a plausible-looking imitation: `status` is the attribute it keys level
// off, and ddsource/ddtags drive its pipeline and facet routing.
const DD_SOURCE = 'nodejs'
const DD_TAGS = 'env:local,fixture:winston'

// Carried on the info object for the formatters, never printed as attributes.
const RESERVED = new Set(['level', 'message', 'timestamp', 'stack'])

// Winston puts a leading "Error: <message>" line on a stack. Printed after
// our own message it lands at column 0, where the viewer refuses to fold it
// into the line above — correctly, since that row is not mid-trace yet — and
// one error would render as two rows. Dropping it also stops the message
// being printed twice.
function frames(stack: unknown): string {
  if (typeof stack !== 'string') return ''
  return '\n' + stack.split('\n').slice(1).join('\n')
}

function renderValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  // Unquoted whitespace would break `key=value` back apart when read.
  return /\s/.test(text) ? JSON.stringify(text) : text
}

// Everything the caller passed as metadata. Winston's own bookkeeping lives on
// Symbol keys, which Object.entries skips for us.
function extras(info: Record<string, unknown>): [string, unknown][] {
  return Object.entries(info).filter(([key]) => !RESERVED.has(key))
}

const TEXT = format.printf((info) => {
  const meta = extras(info as Record<string, unknown>)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(' ')
  // padEnd so the messages line up in a raw terminal too, not just in the
  // viewer, which has its own level column.
  const level = info.level.toUpperCase().padEnd(5)
  return `${info.timestamp} ${level} ${info.message}${meta ? `  ${meta}` : ''}${frames(info.stack)}`
})

const JSON_LINES = format.printf((info) => {
  const { stack, errorKind, errorMessage, ...rest } = info as Record<string, unknown>
  const line: Record<string, unknown> = {
    timestamp: info.timestamp,
    status: info.level,
    message: info.message,
    service: SERVICE,
    ddsource: DD_SOURCE,
    ddtags: DD_TAGS,
  }
  for (const [key, value] of extras(rest)) line[key] = value
  // Datadog's error tracking reads these three specifically.
  if (stack) line.error = { kind: errorKind, message: errorMessage, stack }
  return JSON.stringify(line)
})

export function createLogger(shape: LogFormat): Logger {
  return winstonLogger({
    level: 'debug',
    format: format.combine(
      // A function, not a fecha pattern: fecha formats in local time, so the
      // usual 'YYYY-MM-DDTHH:mm:ss.SSS[Z]' string stamps a local clock and
      // then lies about it with a literal Z.
      format.timestamp({ format: () => new Date().toISOString() }),
      shape === 'json' ? JSON_LINES : TEXT,
    ),
    // One stream for every level. server/invoker.js concatenates stdout and
    // stderr into a single string from separate stream events, so a logger
    // that sends error to stderr and info to stdout has no guaranteed order
    // between them — the lines would interleave differently run to run.
    transports: [new transports.Console({ stderrLevels: [] })],
  })
}
