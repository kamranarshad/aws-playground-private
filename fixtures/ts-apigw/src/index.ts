// Sample TypeScript Lambda behind an API Gateway HTTP API (payload v2).
// Register the fixture folder with handler `dist/index.handler` and build
// command `npm run build` (run `npm install` here once to get tsc).
// The compiled dist/index.js is committed so the fixture works untouched.

interface HttpEvent {
  rawPath?: string
  queryStringParameters?: Record<string, string>
  requestContext?: { http?: { method?: string; path?: string } }
  body?: string
  isBase64Encoded?: boolean
}

interface HttpResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

function respond(statusCode: number, payload: unknown): HttpResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) }
}

export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  const method = event.requestContext?.http?.method ?? 'GET'
  const path = event.rawPath ?? '/'

  if (method === 'GET' && path === '/hello') {
    const name = event.queryStringParameters?.name ?? 'world'
    return respond(200, { message: `hello, ${name} (typescript)` })
  }

  if (method === 'POST' && path === '/sum') {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : event.body ?? ''
    let numbers: unknown
    try {
      numbers = JSON.parse(raw)
    } catch {
      return respond(400, { error: 'invalid JSON body' })
    }
    if (!Array.isArray(numbers) || numbers.some((n) => typeof n !== 'number')) {
      return respond(400, { error: 'body must be a JSON array of numbers' })
    }
    return respond(200, { sum: (numbers as number[]).reduce((a, b) => a + b, 0) })
  }

  return respond(404, { error: 'not found' })
}
