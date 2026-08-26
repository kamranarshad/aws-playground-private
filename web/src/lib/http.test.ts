import { expect, it } from 'vitest'
import { buildCurlCommand } from '@/lib/http'

const fn = { name: 'myfn' }

it('defaults to a plain GET against the function root when the event has no APIGW shape', () => {
  expect(buildCurlCommand(fn, '{}')).toBe("curl -X GET 'http://localhost:9500/myfn/'")
})

it('falls back the same way when the event JSON does not parse', () => {
  expect(buildCurlCommand(fn, '{not json')).toBe("curl -X GET 'http://localhost:9500/myfn/'")
})

it('builds method, path, query string, and headers from an APIGW v2 payload', () => {
  const event = {
    routeKey: 'GET /hello', rawPath: '/hello', rawQueryString: 'name=world',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    queryStringParameters: { name: 'world' },
    requestContext: { http: { method: 'GET' } },
    isBase64Encoded: false,
  }
  expect(buildCurlCommand(fn, JSON.stringify(event))).toBe(
    "curl -X GET 'http://localhost:9500/myfn/hello?name=world' \\\n"
    + "  -H 'accept: */*' \\\n"
    + "  -H 'content-type: application/json'",
  )
})

it('builds the query string from queryStringParameters when rawQueryString is absent', () => {
  const event = { rawPath: '/hello', queryStringParameters: { name: 'world' } }
  expect(buildCurlCommand(fn, JSON.stringify(event)))
    .toBe("curl -X GET 'http://localhost:9500/myfn/hello?name=world'")
})

it('base64-decodes the body when isBase64Encoded is true', () => {
  const event = {
    rawPath: '/sum', requestContext: { http: { method: 'POST' } },
    body: btoa('{"a":1,"b":2}'), isBase64Encoded: true,
  }
  expect(buildCurlCommand(fn, JSON.stringify(event))).toBe(
    "curl -X POST 'http://localhost:9500/myfn/sum' \\\n"
    + "  --data-raw '{\"a\":1,\"b\":2}'",
  )
})

it('passes the body through as-is when isBase64Encoded is false', () => {
  const event = {
    rawPath: '/sum', requestContext: { http: { method: 'POST' } },
    body: '{"a":1,"b":2}', isBase64Encoded: false,
  }
  expect(buildCurlCommand(fn, JSON.stringify(event))).toBe(
    "curl -X POST 'http://localhost:9500/myfn/sum' \\\n"
    + "  --data-raw '{\"a\":1,\"b\":2}'",
  )
})

it('omits host, content-length, and connection headers since curl computes them itself', () => {
  const event = { headers: { host: 'localhost:9500', 'content-length': '0', connection: 'keep-alive', accept: '*/*' } }
  expect(buildCurlCommand(fn, JSON.stringify(event)))
    .toBe("curl -X GET 'http://localhost:9500/myfn/' \\\n  -H 'accept: */*'")
})

it('single-quote-escapes values containing a single quote', () => {
  const event = { rawQueryString: "name=o'brien" }
  expect(buildCurlCommand(fn, JSON.stringify(event)))
    .toBe("curl -X GET 'http://localhost:9500/myfn/?name=o'\\''brien'")
})

it('percent-encodes the function name segment, since the listener decodes it when routing', () => {
  const event = { rawPath: '/hello', queryStringParameters: { name: 'world' } }
  expect(buildCurlCommand({ name: 'api gateway' }, JSON.stringify(event)))
    .toBe("curl -X GET 'http://localhost:9500/api%20gateway/hello?name=world'")
})

it('reads method and path from the v1 REST API shape when present', () => {
  const event = { path: '/hello', httpMethod: 'GET' }
  expect(buildCurlCommand(fn, JSON.stringify(event)))
    .toBe("curl -X GET 'http://localhost:9500/myfn/hello'")
})
