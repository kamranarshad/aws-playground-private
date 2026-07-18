# Node.js API Gateway fixture

A sample Node.js Lambda for the playground that takes an API Gateway
HTTP API (payload format 2.0) event as input, so users can see a
realistic request/response round-trip instead of a bare echo.

## Scope

New fixture project `fixtures/node-apigw/`. No server, harness, or UI
changes — it registers in the playground like any project folder with
handler `index.handler`.

## Handler (`fixtures/node-apigw/index.js`)

`exports.handler` is async and reads the v2 payload shape:
`event.requestContext.http.method` and `event.rawPath`.

Routes:

- `GET /hello` → 200 `{"message": "hello, <name>"}` where `<name>` comes
  from `queryStringParameters.name`, defaulting to `world`.
- `POST /echo` → parses the JSON body (decoding base64 first when
  `isBase64Encoded` is true) and returns 200 `{"received": <body>}`.
  Invalid JSON → 400 `{"error": "invalid JSON body"}`.
- Anything else → 404 `{"error": "not found"}`.

Every response is a proxy-integration object:
`{ statusCode, headers: {"content-type": "application/json"}, body }`
with `body` a JSON string — exactly what API Gateway would relay to the
client.

## Sample events (`fixtures/node-apigw/events/`)

- `get-hello.json` — realistic v2 event for `GET /hello?name=Kamran`.
- `post-echo.json` — v2 event for `POST /echo` with a JSON body.

Users paste or load these in the playground UI event editor.

## Testing

Cases added to `tests/harness-node.test.js`, run through the existing
`runHarness` helper against the new fixture: GET route with query param,
POST route with body, and the 404 fallback.
