// Sample TypeScript Lambda that logs through winston, for exercising the
// playground's Logs tab. Register the fixture folder with handler
// `dist/index.handler`; the committed bundle runs without an npm install.
//
// Invoke with `{}` for the text layout the Logs tab parses, or
// `{"format":"json"}` for the JSON shape Datadog's intake prefers — which
// the tab does not parse, so every row comes out level-less. Both are worth
// seeing.
import { createLogger, type LogFormat } from './logger'

interface LogEvent {
  format?: LogFormat
  orderId?: string
}

interface Result {
  statusCode: number
  headers: Record<string, string>
  body: string
}

// Two frames deep, so the logged stack has something to fold in the viewer.
function readFromStore(orderId: string): never {
  throw new RangeError(`no order matching '${orderId}' in the local store`)
}

function lookupOrder(orderId: string): never {
  return readFromStore(orderId)
}

export const handler = async (event: LogEvent): Promise<Result> => {
  const shape: LogFormat = event.format === 'json' ? 'json' : 'text'
  const orderId = event.orderId ?? 'A-1001'
  const log = createLogger(shape)

  log.debug('payload parsed', { format: shape })
  log.info('fetching order', { order_id: orderId })
  log.warn('slow downstream call', { order_id: orderId, duration_ms: 812 })

  // Deliberately not through winston: one unadorned line, so the viewer has a
  // row with no level and no timestamp sitting among the parsed ones.
  console.log('plain console.log - no level, no timestamp')

  try {
    lookupOrder(orderId)
  } catch (err) {
    const error = err as Error
    // The stack rides along as metadata rather than through
    // format.errors({ stack: true }), so both formatters read one explicit
    // field instead of depending on winston's error plumbing.
    log.error('order lookup failed', {
      order_id: orderId,
      errorKind: error.name,
      errorMessage: error.message,
      stack: error.stack,
    })
  }

  log.info('handler complete', { order_id: orderId })

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, orderId, logFormat: shape }),
  }
}
