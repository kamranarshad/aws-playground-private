export const HTTP_TRIGGER_PORT = 9500 // must match server/trigger/http.js's PORT

const SKIPPED_HEADERS = new Set(['host', 'content-length', 'connection'])

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Best-effort: treats eventText as an API Gateway v1/v2 proxy payload (the
// shape the real HTTP trigger listener builds from, and the shape the
// "API Gateway HTTP API v2" event template already produces), pulling
// whatever fields are present. Unparseable JSON or a payload missing every
// field still yields a working GET against the function's root rather than
// an error — the point is a repro to hand off, not a strict validator.
export function buildCurlCommand(fn: { name: string }, eventText: string): string {
  let event: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(eventText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      event = parsed as Record<string, unknown>
    }
  } catch {
    // fall through with the default empty event
  }

  const requestContext = event.requestContext as { http?: { method?: unknown } } | undefined
  const method = (typeof requestContext?.http?.method === 'string' && requestContext.http.method)
    || (typeof event.httpMethod === 'string' && event.httpMethod)
    || 'GET'

  const rawPath = (typeof event.rawPath === 'string' && event.rawPath)
    || (typeof event.path === 'string' && event.path)
    || '/'

  let query = ''
  if (typeof event.rawQueryString === 'string' && event.rawQueryString) {
    query = event.rawQueryString
  } else if (event.queryStringParameters && typeof event.queryStringParameters === 'object') {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(event.queryStringParameters as Record<string, unknown>)) {
      if (typeof value === 'string') params.append(key, value)
    }
    query = params.toString()
  }

  // fn.name is a plain string, but rawPath comes straight from the event
  // JSON already percent-encoded (real API Gateway's rawPath is encoded,
  // and the HTTP trigger listener decodes only the name segment when
  // routing) — so only the name needs encoding here, not rawPath.
  const url = `http://localhost:${HTTP_TRIGGER_PORT}/${encodeURIComponent(fn.name)}`
    + `${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}${query ? `?${query}` : ''}`

  const headers: [string, string][] = event.headers && typeof event.headers === 'object'
    ? Object.entries(event.headers as Record<string, unknown>)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !SKIPPED_HEADERS.has(entry[0].toLowerCase()))
    : []

  let body: string | null = null
  if (typeof event.body === 'string' && event.body) {
    body = event.isBase64Encoded === true
      ? (() => { try { return atob(event.body as string) } catch { return event.body as string } })()
      : event.body
  }

  const parts = [`-X ${method} ${shQuote(url)}`]
  for (const [key, value] of headers) parts.push(`-H ${shQuote(`${key}: ${value}`)}`)
  if (body !== null) parts.push(`--data-raw ${shQuote(body)}`)

  return `curl ${parts.join(' \\\n  ')}`
}

// A response is "API Gateway proxy-shaped" when it carries an integer
// statusCode in the valid HTTP range; only then do we surface an HTTP badge.
export function httpStatusOf(response: unknown): number | null {
  if (typeof response !== 'object' || response === null) return null
  const status = (response as { statusCode?: unknown }).statusCode
  if (typeof status !== 'number' || !Number.isInteger(status)) return null
  if (status < 100 || status > 599) return null
  return status
}

export function httpStatusClass(status: number): string {
  if (status < 300) return 'border-transparent bg-success/15 text-success'
  if (status < 400) return 'border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400'
  if (status < 500) return 'border-transparent bg-brand/15 text-brand'
  return 'border-transparent bg-destructive/15 text-destructive'
}
