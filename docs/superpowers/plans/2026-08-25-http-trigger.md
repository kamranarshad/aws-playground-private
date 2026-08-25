# HTTP (API Gateway) Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered function be invoked by a real HTTP request from another local app — the HTTP analog of the existing SQS trigger — by adding a shared listener that routes requests by function name and returns the handler's return value as the actual HTTP response.

**Architecture:** A new `server/trigger/http.js` module owns a single shared `http.createServer` listener and the pure request/response translation logic (API Gateway HTTP API v2 event in, proxy response out). `server/trigger/manager.js` (already the lifecycle owner for the SQS poller) is extended with a second code path that keeps a live `name -> functionId` route table and starts/stops the shared listener as functions enable/disable an HTTP trigger. `server/api/functions.js` gains function-name uniqueness (required for unambiguous routing) and `trigger.type === 'http'` validation. The web UI's existing trigger section becomes a type selector (None/SQS/HTTP).

**Tech Stack:** Node's built-in `http`/`url` modules only — no new npm dependency (unlike the SQS trigger, which added `@aws-sdk/client-sqs`).

**Spec:** `docs/superpowers/specs/2026-08-25-http-trigger-design.md`

## Global Constraints

- Fixed port `9500` for the shared HTTP trigger listener (`server/trigger/http.js`'s `PORT` constant) — no CLI flag, no per-function port.
- The route prefix is the function's `name` field (`http://localhost:9500/<name>/<...rest>`), not a separate user-set field.
- Function `name` must be globally unique — enforced in `server/api/functions.js`, both create and update.
- `trigger` stays a single object per function: `{ type: 'sqs', queueName, enabled }` or `{ type: 'http', enabled }` — never both at once.
- The existing single-invoke-in-flight guard applies to HTTP-triggered invokes too; a conflict surfaces to the HTTP caller as `429` (not `409`, since the caller needs an HTTP-appropriate status).
- A handler error or a return value that isn't a valid `{statusCode, body?, headers?}` proxy response surfaces as `502`.
- Event/response shape is API Gateway **HTTP API payload v2** only (`rawPath`, `requestContext.http.method`, `queryStringParameters`, `body`, `isBase64Encoded`) — matches `fixtures/typescript/apigw`, which the plan reuses untouched as the worked example.
- No queueing, no HTTPS/TLS, no auth on the listener — `127.0.0.1`-only, same trust model as the rest of the playground.

---

## Task 1: Function-name uniqueness and `trigger.type === 'http'` validation

**Files:**
- Modify: `server/api/functions.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `store.list()`, `store.get(id)` (already imported in `server/api/functions.js`).
- Produces: `fieldError(fields, currentId = null)` — signature changes from `fieldError(fields)` to accept an optional `currentId` (the function's own id on update, so it can exclude itself from the uniqueness check). Both call sites (`createFunction`, `updateFunction`) are updated in this task.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api.test.js`, right after the existing `'trigger field validation on create and update'` test (after line 89, before the `'updating a function trigger notifies the trigger manager...'` test):

```js
test('function names must be globally unique', () => {
  const a = api.createFunction({ name: 'uniq-a', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(a.status, 201);

  const dup = api.createFunction({ name: 'uniq-a', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.body.error, /already exists/);

  const b = api.createFunction({ name: 'uniq-b', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(b.status, 201);

  // Renaming into a collision is rejected...
  let r = api.updateFunction(b.body.id, { name: 'uniq-a' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /already exists/);

  // ...but saving a function's own unchanged name is not a collision with itself.
  r = api.updateFunction(a.body.id, { name: 'uniq-a' });
  assert.strictEqual(r.status, 200);
});

test('trigger.type "http" requires a boolean enabled and a name without slashes', () => {
  let r = api.createFunction({ name: 'http-trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'http', enabled: 'yes' } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'http-trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'http', enabled: false } });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body.trigger, { type: 'http', enabled: false });
  const id = r.body.id;

  // Enabling it is fine (name has no slash)...
  r = api.updateFunction(id, { trigger: { type: 'http', enabled: true } });
  assert.strictEqual(r.status, 200);

  // ...but a name containing '/' can't be enabled as an HTTP trigger route.
  r = api.updateFunction(id, { name: 'has/slash', trigger: { type: 'http', enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /without .\/. characters/);
});

test('enabling an HTTP trigger is rejected if another function already has that name', () => {
  const a = api.createFunction({ name: 'dup-route', path: FIXTURES, runtime: 'node' });
  assert.strictEqual(a.status, 201);
  // A grandfathered duplicate name (created before this validation existed, or
  // via a path that bypasses it) must still be caught here, not just at create time.
  const store = require('../server/store');
  store.create({ name: 'dup-route', path: FIXTURES, runtime: 'node' });

  const r = api.updateFunction(a.body.id, { trigger: { type: 'http', enabled: true } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /already exists/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/api.test.js`
Expected: the three new tests FAIL (name uniqueness isn't enforced yet; `trigger.type === 'http'` isn't recognized yet — `'unsupported trigger type 'http''` errors appear where 201/200 was expected).

- [ ] **Step 3: Implement the validation**

Replace `server/api/functions.js` in full with:

```js
const fs = require('fs');
const store = require('../store');
const { detectProject } = require('../detect');
const history = require('../history');
const inFlight = require('./in-flight');
const manager = require('../trigger/manager');

const RUNTIMES = ['python', 'node', 'java', 'provided'];

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

function triggerError(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (trigger.type !== 'sqs' && trigger.type !== 'http') {
    return `unsupported trigger type '${trigger.type}'`;
  }
  if (trigger.type === 'sqs' && (typeof trigger.queueName !== 'string' || !trigger.queueName.trim())) {
    return 'trigger.queueName is required';
  }
  if (typeof trigger.enabled !== 'boolean') return 'trigger.enabled must be a boolean';
  return null;
}

// Shared between create (fields always present) and update (fields present
// only when patched) so a PATCH can't put the store into a state POST would
// have rejected — e.g. a non-numeric timeoutMs, which downstream clamps
// setTimeout to ~1ms and SIGKILLs every future invoke almost instantly.
// `currentId` is the function's own id on update (excluded from the name
// collision checks below); null on create, where there's no "self" yet.
function fieldError(fields, currentId = null) {
  if ('runtime' in fields && !RUNTIMES.includes(fields.runtime)) {
    return `unsupported runtime '${fields.runtime}'`;
  }
  if ('path' in fields
    && (!fs.existsSync(fields.path) || !fs.statSync(fields.path).isDirectory())) {
    return `path is not a directory: ${fields.path}`;
  }
  if ('timeoutMs' in fields && !(Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0)) {
    return 'timeoutMs must be a positive number';
  }
  if ('memoryMb' in fields && !(Number.isFinite(fields.memoryMb) && fields.memoryMb > 0)) {
    return 'memoryMb must be a positive number';
  }
  // Required for the HTTP trigger's routing-by-name to be unambiguous, but
  // enforced unconditionally (not just when a trigger is involved) — the
  // simpler, single rule to reason about.
  if ('name' in fields
    && typeof fields.name === 'string'
    && store.list().some((f) => f.name === fields.name && f.id !== currentId)) {
    return `a function named '${fields.name}' already exists`;
  }
  if ('trigger' in fields) {
    const triggerErr = triggerError(fields.trigger);
    if (triggerErr) return triggerErr;
    if (fields.trigger?.type === 'http' && fields.trigger.enabled) {
      // The effective name is whatever this patch leaves in place: the new
      // name if it's being changed here, otherwise the function's current
      // stored name.
      const name = 'name' in fields ? fields.name : (currentId ? store.get(currentId)?.name : undefined);
      if (typeof name === 'string' && name.includes('/')) {
        return "an HTTP trigger requires a name without '/' characters";
      }
      if (typeof name === 'string'
        && store.list().some((f) => f.name === name && f.id !== currentId)) {
        return `a function named '${name}' already exists — rename it before enabling an HTTP trigger`;
      }
    }
  }
  return null;
}

function createFunction(input) {
  const { name, path: dir, runtime } = input || {};
  if (!name || !dir || !runtime) {
    return { status: 400, body: { error: 'name, path and runtime are required' } };
  }
  const err = fieldError(input);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.create(input);
  manager.sync(fn);
  return { status: 201, body: fn };
}

function updateFunction(id, patch) {
  const p = patch || {};
  const err = fieldError(p, id);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.update(id, p);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  manager.sync(fn);
  return { status: 200, body: fn };
}

function deleteFunction(id) {
  if (inFlight.has(id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  manager.stop(id);
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}

function detect(input) {
  const dir = (input || {}).path;
  if (!dir) return { status: 400, body: { error: 'path is required' } };
  return { status: 200, body: detectProject(dir) };
}

module.exports = { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/api.test.js`
Expected: PASS, including every pre-existing test in the file (the `'trigger field validation on create and update'` test's four `'trig'`-named calls and the `'function CRUD with validation'` test's three `'x'`-named calls never actually create a function before their final success, so the new uniqueness check doesn't collide with them — confirm by reading the output, not just trusting this).

- [ ] **Step 5: Commit**

```bash
git add server/api/functions.js tests/api.test.js
git commit -m "feat(api): require unique function names; validate http trigger config"
```

---

## Task 2: Pure event/response translation for the HTTP trigger

**Files:**
- Create: `server/trigger/http.js` (this task implements everything except `createListener`/`createRequestHandler`, added in Task 3 — see note below)
- Test: `tests/http-trigger.test.js`

**Interfaces:**
- Produces: `routeFor(req)` → `{ name: string, rawPath: string, url: URL }`; `encodeBody(buffer: Buffer)` → `{ body: string | undefined, isBase64Encoded: boolean }`; `buildHttpEvent({ method, rawPath, url, headers, bodyBuffer })` → API Gateway HTTP API v2 event object; `isValidProxyResponse(resp)` → `boolean`; `translateInvokeResult(result)` → `{ status: number, headers: object, bodyBuffer: Buffer }`. All pure — no network, no `require('../api/invoke')`.

This task and Task 3 both edit `server/trigger/http.js` and both edit `tests/http-trigger.test.js` — they're split because the pure functions here are independently testable and reviewable before the real-listener wiring lands on top of them, but they land in the same commit-worthy file pair. Do them as written, in order.

- [ ] **Step 1: Write the failing tests**

Create `tests/http-trigger.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  routeFor, encodeBody, buildHttpEvent, isValidProxyResponse, translateInvokeResult,
} = require('../server/trigger/http');

function req(url, headers = {}) {
  return { url, headers };
}

test('routeFor splits the first path segment as the function name', () => {
  const r = routeFor(req('/node/hello?name=x'));
  assert.strictEqual(r.name, 'node');
  assert.strictEqual(r.rawPath, '/hello');
  assert.strictEqual(r.url.searchParams.get('name'), 'x');
});

test('routeFor decodes a percent-encoded name but leaves the remaining path raw', () => {
  const r = routeFor(req('/my%20fn/some%20path'));
  assert.strictEqual(r.name, 'my fn');
  assert.strictEqual(r.rawPath, '/some%20path');
});

test('routeFor falls back to "/" when there is nothing after the name', () => {
  const r = routeFor(req('/node'));
  assert.strictEqual(r.name, 'node');
  assert.strictEqual(r.rawPath, '/');
});

test('encodeBody keeps valid UTF-8 text as-is', () => {
  const { body, isBase64Encoded } = encodeBody(Buffer.from('{"hello":"world"}', 'utf8'));
  assert.strictEqual(body, '{"hello":"world"}');
  assert.strictEqual(isBase64Encoded, false);
});

test('encodeBody base64-encodes bytes that are not valid UTF-8', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const { body, isBase64Encoded } = encodeBody(bytes);
  assert.strictEqual(isBase64Encoded, true);
  assert.deepStrictEqual(Buffer.from(body, 'base64'), bytes);
});

test('encodeBody treats an empty body as undefined, not an empty string', () => {
  const { body, isBase64Encoded } = encodeBody(Buffer.alloc(0));
  assert.strictEqual(body, undefined);
  assert.strictEqual(isBase64Encoded, false);
});

test('buildHttpEvent shapes an API Gateway HTTP API v2 event', () => {
  const url = new URL('http://internal/hello?name=you');
  const event = buildHttpEvent({
    method: 'GET', rawPath: '/hello', url, headers: { host: 'localhost' }, bodyBuffer: Buffer.alloc(0),
  });
  assert.strictEqual(event.rawPath, '/hello');
  assert.strictEqual(event.rawQueryString, 'name=you');
  assert.deepStrictEqual(event.queryStringParameters, { name: 'you' });
  assert.strictEqual(event.requestContext.http.method, 'GET');
  assert.strictEqual(event.requestContext.http.path, '/hello');
  assert.strictEqual(event.body, undefined);
  assert.strictEqual(event.isBase64Encoded, false);
});

test('buildHttpEvent omits queryStringParameters when there is no query string', () => {
  const url = new URL('http://internal/hello');
  const event = buildHttpEvent({ method: 'GET', rawPath: '/hello', url, headers: {}, bodyBuffer: Buffer.alloc(0) });
  assert.strictEqual(event.queryStringParameters, undefined);
  assert.strictEqual(event.rawQueryString, '');
});

test('isValidProxyResponse accepts a minimal proxy response and rejects malformed shapes', () => {
  assert.strictEqual(isValidProxyResponse({ statusCode: 200 }), true);
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, body: 'x', headers: { a: 'b' } }), true);
  assert.strictEqual(isValidProxyResponse(null), false);
  assert.strictEqual(isValidProxyResponse({}), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: '200' }), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, body: 123 }), false);
});

test('translateInvokeResult converts a 409 in-flight guard into 429', () => {
  const r = translateInvokeResult({ status: 409, body: { error: 'in flight' } });
  assert.strictEqual(r.status, 429);
  assert.deepStrictEqual(JSON.parse(r.bodyBuffer), { error: 'an invoke is already in flight for this function' });
});

test('translateInvokeResult converts a 404 into a 404 JSON error', () => {
  const r = translateInvokeResult({ status: 404, body: { error: 'function not found' } });
  assert.strictEqual(r.status, 404);
});

test('translateInvokeResult returns 502 when the handler errored', () => {
  const r = translateInvokeResult({ status: 200, body: { ok: false, error: { message: 'boom' } } });
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(JSON.parse(r.bodyBuffer), { error: 'handler error', detail: 'boom' });
});

test('translateInvokeResult returns 502 when the handler response is not a valid proxy response', () => {
  const r = translateInvokeResult({ status: 200, body: { ok: true, response: { just: 'an object' } } });
  assert.strictEqual(r.status, 502);
  assert.match(JSON.parse(r.bodyBuffer).error, /malformed/);
});

test('translateInvokeResult passes through a valid proxy response, decoding base64 bodies', () => {
  const r = translateInvokeResult({
    status: 200,
    body: {
      ok: true,
      response: {
        statusCode: 201, headers: { 'x-test': '1' }, body: 'aGVsbG8=', isBase64Encoded: true,
      },
    },
  });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.headers, { 'x-test': '1' });
  assert.strictEqual(r.bodyBuffer.toString('utf8'), 'hello');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/http-trigger.test.js`
Expected: FAIL with `Cannot find module '../server/trigger/http'`.

- [ ] **Step 3: Implement the pure functions**

Create `server/trigger/http.js` with exactly this content (Task 3 appends `createRequestHandler`/`createListener` to the same file and extends the `module.exports` line — don't add them now):

```js
const http = require('http');

const PORT = 9500;
const HOST = '127.0.0.1';
const JSON_HEADERS = { 'content-type': 'application/json' };

// Splits '/name/rest/of/path' into the routing name and the path the
// handler sees. The name is decoded (so a function called "my fn" is
// reachable at /my%20fn/...); the rest is left exactly as received, the
// same way a real API Gateway's rawPath is percent-encoded.
function routeFor(req) {
  const url = new URL(req.url, 'http://internal');
  const withoutLeadingSlash = url.pathname.slice(1);
  const slashIdx = withoutLeadingSlash.indexOf('/');
  const rawName = slashIdx === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slashIdx);
  const rest = slashIdx === -1 ? '' : withoutLeadingSlash.slice(slashIdx);
  let name;
  try { name = decodeURIComponent(rawName); } catch { name = rawName; }
  return { name, rawPath: rest || '/', url };
}

// Round-trips through UTF-8 and compares bytes rather than sniffing
// content-type, so any body that happens to be valid UTF-8 text is sent as
// text (matching what most real handlers expect) and anything else — images,
// arbitrary binary — is base64-encoded losslessly, the same choice a real
// API Gateway integration makes based on binary media types.
function encodeBody(buffer) {
  if (buffer.length === 0) return { body: undefined, isBase64Encoded: false };
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buffer)) return { body: text, isBase64Encoded: false };
  return { body: buffer.toString('base64'), isBase64Encoded: true };
}

function buildHttpEvent({ method, rawPath, url, headers, bodyBuffer }) {
  const { body, isBase64Encoded } = encodeBody(bodyBuffer);
  const queryStringParameters = {};
  for (const [k, v] of url.searchParams) queryStringParameters[k] = v;
  return {
    rawPath,
    rawQueryString: url.search ? url.search.slice(1) : '',
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : undefined,
    headers,
    requestContext: { http: { method, path: rawPath } },
    body,
    isBase64Encoded,
  };
}

function isValidProxyResponse(resp) {
  return !!resp && typeof resp === 'object'
    && Number.isInteger(resp.statusCode)
    && (resp.body === undefined || typeof resp.body === 'string')
    && (resp.headers === undefined || (typeof resp.headers === 'object' && resp.headers !== null));
}

function jsonResult(status, obj) {
  return { status, headers: JSON_HEADERS, bodyBuffer: Buffer.from(JSON.stringify(obj)) };
}

// Turns an invokeFunction() result into what the HTTP caller should see.
// 409 (another invoke already in flight) becomes 429 — the SQS poller can
// just skip a poll cycle on a 409, but an HTTP caller is waiting on this
// connection and needs an actual response now. A handler error, or a return
// value that isn't a real proxy response shape, becomes 502 — mirroring how
// a real API Gateway reports a malformed Lambda proxy integration response.
function translateInvokeResult(result) {
  if (result.status === 409) {
    return jsonResult(429, { error: 'an invoke is already in flight for this function' });
  }
  if (result.status === 404) {
    return jsonResult(404, { error: 'function not found' });
  }
  const inv = result.body;
  if (!inv?.ok) {
    return jsonResult(502, { error: 'handler error', detail: inv?.error?.message ?? 'invoke failed' });
  }
  if (!isValidProxyResponse(inv.response)) {
    return jsonResult(502, {
      error: 'malformed Lambda proxy response',
      detail: 'handler must return { statusCode: number, body?: string, headers?: object }',
    });
  }
  const resp = inv.response;
  const bodyBuffer = resp.isBase64Encoded
    ? Buffer.from(resp.body ?? '', 'base64')
    : Buffer.from(resp.body ?? '', 'utf8');
  return { status: resp.statusCode, headers: resp.headers ?? {}, bodyBuffer };
}

module.exports = {
  PORT, HOST, routeFor, encodeBody, buildHttpEvent, isValidProxyResponse, translateInvokeResult,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/http-trigger.test.js`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Commit**

```bash
git add server/trigger/http.js tests/http-trigger.test.js
git commit -m "feat(trigger): add HTTP trigger event/response translation"
```

---

## Task 3: The shared HTTP listener

**Files:**
- Modify: `server/trigger/http.js` (append to the file from Task 2)
- Test: `tests/http-trigger.test.js` (append to the file from Task 2)

**Interfaces:**
- Consumes: `routeFor`, `buildHttpEvent`, `translateInvokeResult` (from Task 2, same file, no import needed).
- Produces: `createRequestHandler({ resolveFunctionId, invokeFunction })` → `(req, res) => Promise<void>`; `createListener({ resolveFunctionId, invokeFunction, port = PORT, host = HOST, onError })` → `Promise<{ server: http.Server, stop: () => void }>`. `resolveFunctionId: (name: string) => string | null` and `invokeFunction: (input) => Promise<{status, body}>` (the same signature `server/api/invoke.js`'s `invokeFunction` already has) are both injected — Task 4's manager module supplies the real ones; these tests supply fakes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/http-trigger.test.js`:

```js
const http = require('http');
const { createListener } = require('../server/trigger/http');

function request(port, pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, host: '127.0.0.1', path: pathAndQuery, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('the listener routes by name, invokes the function, and returns its proxy response', async () => {
  const invokeCalls = [];
  const listener = await createListener({
    port: 0,
    resolveFunctionId: (name) => (name === 'myfn' ? 'fn-id-1' : null),
    invokeFunction: async (input) => {
      invokeCalls.push(input);
      return {
        status: 200,
        body: { ok: true, response: { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: `hi ${input.event.rawPath}` } },
      };
    },
  });
  try {
    const port = listener.server.address().port;
    const res = await request(port, '/myfn/hello?x=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'hi /hello');
    assert.strictEqual(invokeCalls.length, 1);
    assert.strictEqual(invokeCalls[0].functionId, 'fn-id-1');
    assert.deepStrictEqual(invokeCalls[0].source, { type: 'trigger', method: 'GET', path: '/hello' });
  } finally {
    listener.stop();
  }
});

test('the listener responds 404 for a name with no registered route', async () => {
  const listener = await createListener({
    port: 0,
    resolveFunctionId: () => null,
    invokeFunction: async () => { throw new Error('should not be called'); },
  });
  try {
    const port = listener.server.address().port;
    const res = await request(port, '/unknown/hello');
    assert.strictEqual(res.status, 404);
  } finally {
    listener.stop();
  }
});

test('the listener responds 500 when invokeFunction itself throws', async () => {
  const listener = await createListener({
    port: 0,
    resolveFunctionId: () => 'fn-id-1',
    invokeFunction: async () => { throw new Error('handler crashed'); },
  });
  try {
    const port = listener.server.address().port;
    const res = await request(port, '/myfn/hello');
    assert.strictEqual(res.status, 500);
  } finally {
    listener.stop();
  }
});

test('the listener passes the request body through and responds 429 on an in-flight conflict', async () => {
  const listener = await createListener({
    port: 0,
    resolveFunctionId: () => 'fn-id-1',
    invokeFunction: async (input) => {
      assert.strictEqual(input.event.body, '{"a":1}');
      return { status: 409, body: { error: 'in flight' } };
    },
  });
  try {
    const port = listener.server.address().port;
    const res = await request(port, '/myfn/sum', { method: 'POST', body: '{"a":1}' });
    assert.strictEqual(res.status, 429);
  } finally {
    listener.stop();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/http-trigger.test.js`
Expected: FAIL — `createListener` is not exported yet.

- [ ] **Step 3: Implement the listener**

Append to `server/trigger/http.js`, just above `module.exports`:

```js
function sendResult(res, result) {
  res.writeHead(result.status, result.headers);
  res.end(result.bodyBuffer);
}

function createRequestHandler({ resolveFunctionId, invokeFunction }) {
  return async function handleRequest(req, res) {
    try {
      const { name, rawPath, url } = routeFor(req);
      const functionId = resolveFunctionId(name);
      if (!functionId) {
        return sendResult(res, jsonResult(404, { error: `no function registered for "${name}"` }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuffer = Buffer.concat(chunks);
      const event = buildHttpEvent({ method: req.method, rawPath, url, headers: req.headers, bodyBuffer });
      const result = await invokeFunction({
        functionId, event, source: { type: 'trigger', method: req.method, path: rawPath },
      });
      sendResult(res, translateInvokeResult(result));
    } catch (err) {
      // An invokeFunction() rejection is a bug, not a normal Lambda error —
      // translateInvokeResult only handles results it actually returned.
      if (!res.headersSent) sendResult(res, jsonResult(500, { error: err.message }));
      else res.destroy();
    }
  };
}

// One shared listener across every function with an enabled HTTP trigger;
// `resolveFunctionId` is called fresh on every request, so the caller (the
// trigger manager) can mutate its route table live without restarting this
// listener.
function createListener({ resolveFunctionId, invokeFunction, port = PORT, host = HOST, onError }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler({ resolveFunctionId, invokeFunction }));
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      if (onError) server.on('error', onError);
      resolve({ server, stop: () => server.close() });
    });
  });
}
```

Change the `module.exports` line at the bottom of the file to:

```js
module.exports = {
  PORT, HOST, routeFor, encodeBody, buildHttpEvent, isValidProxyResponse, translateInvokeResult,
  createRequestHandler, createListener,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/http-trigger.test.js`
Expected: PASS (all 17 tests — 13 from Task 2, 4 new).

- [ ] **Step 5: Commit**

```bash
git add server/trigger/http.js tests/http-trigger.test.js
git commit -m "feat(trigger): add the shared HTTP trigger listener"
```

---

## Task 4: Wire the HTTP trigger into the trigger manager

**Files:**
- Modify: `server/trigger/manager.js`
- Test: `tests/trigger-manager.test.js`

**Interfaces:**
- Consumes: `httpTrigger.createListener` (Task 3), `httpTrigger.PORT`; `store.list()`/`store.get()` (already used); `require('../api/invoke').invokeFunction` (lazy-required inside the function that needs it, matching how `server/trigger/sqs.js` already avoids a load-time circular require).
- Produces: `manager.sync(fn)`, `manager.stop(id)`, `manager.resumeAll()`, `manager.stopAll()`, `manager.status(id)`, `manager.statusAll()` — same public signatures as today; every existing caller (`server/api/functions.js`, `bin/cli.js`, `server/api/triggers.js`) needs no changes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/trigger-manager.test.js`. First, add this near the top of the file, right after the existing `const manager = require('../server/trigger/manager');` line:

```js
const httpTrigger = require('../server/trigger/http');
const originalCreateListener = httpTrigger.createListener;
```

Then append these tests at the end of the file:

```js
test('sync registers an HTTP route and starts the shared listener when a trigger is enabled', async () => {
  let calls = 0;
  let stopped = false;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'h1', path: '/tmp/h1', runtime: 'node',
      trigger: { type: 'http', enabled: true } });

    await manager.sync(fn);

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('the shared listener starts once and keeps running for the other function when one of several is disabled', async () => {
  let calls = 0;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const a = store.create({ name: 'h2a', path: '/tmp/h2a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h2b', path: '/tmp/h2b', runtime: 'node', trigger: { type: 'http', enabled: true } });

    await manager.sync(a);
    await manager.sync(b);
    assert.strictEqual(calls, 1);

    manager.stop(a.id);
    assert.deepStrictEqual(manager.status(b.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(b.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('two functions enabling their http trigger concurrently only start one listener', async () => {
  let calls = 0;
  let resolveStart;
  httpTrigger.createListener = () => new Promise((resolve) => {
    calls++;
    resolveStart = () => resolve({ stop: () => {}, server: { address: () => ({ port: 9500 }) } });
  });
  try {
    const a = store.create({ name: 'h3a', path: '/tmp/h3a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h3b', path: '/tmp/h3b', runtime: 'node', trigger: { type: 'http', enabled: true } });

    const p1 = manager.sync(a);
    const p2 = manager.sync(b);
    resolveStart();
    await Promise.all([p1, p2]);

    assert.strictEqual(calls, 1);
    manager.stop(a.id);
    manager.stop(b.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('sync moves the route when the function is renamed while the trigger stays enabled', async () => {
  let calls = 0;
  const registered = [];
  httpTrigger.createListener = async ({ resolveFunctionId }) => {
    calls++;
    registered.push(resolveFunctionId);
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    let fn = store.create({ name: 'h4', path: '/tmp/h4', runtime: 'node', trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id, { name: 'h4-renamed' });
    await manager.sync(fn);

    assert.strictEqual(calls, 1, 'a rename must not restart the shared listener');
    const resolve = registered[0];
    assert.strictEqual(resolve('h4'), null, 'the old name must no longer route');
    assert.strictEqual(resolve('h4-renamed'), fn.id);
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('switching a function from an sqs trigger to an http trigger stops the poller and registers the http route', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let sqsStopped = false;
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { sqsStopped = true; } }; };
  let httpCalls = 0;
  httpTrigger.createListener = async () => {
    httpCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    let fn = store.create({ name: 'h5', path: '/tmp/h5', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q5', enabled: true } });
    await manager.sync(fn);

    fn = store.update(fn.id, { trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);

    assert.strictEqual(sqsStopped, true);
    assert.strictEqual(httpCalls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    httpTrigger.createListener = originalCreateListener;
  }
});

test('a listener start failure is reported as an error status', async () => {
  httpTrigger.createListener = async () => { throw new Error('EADDRINUSE: address already in use 127.0.0.1:9500'); };
  try {
    const fn = store.create({ name: 'h6', path: '/tmp/h6', runtime: 'node', trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);
    const st = manager.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /EADDRINUSE/);
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('resumeAll starts the shared listener for every function with an enabled http trigger; stopAll tears it down', async () => {
  let calls = 0;
  let stopped = false;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const a = store.create({ name: 'h7a', path: '/tmp/h7a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h7b', path: '/tmp/h7b', runtime: 'node' });

    await manager.resumeAll();

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(manager.status(a.id), { state: 'listening', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(manager.status(b.id), { state: 'idle', lastError: null, lastPolledAt: null });

    manager.stopAll();
    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(manager.status(a.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/trigger-manager.test.js`
Expected: FAIL — `manager.sync` doesn't recognize `trigger.type === 'http'` yet (status stays `idle`, `httpTrigger.createListener` is never called).

- [ ] **Step 3: Implement the manager changes**

Replace `server/trigger/manager.js` in full with:

```js
const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');
const httpTrigger = require('./http');

// functionId -> { queueName, stop, status }  (one SQS poller per function)
const running = new Map();

// The HTTP trigger is one shared listener across every function that enables
// it, not one per function like SQS — httpRoutes is read live by the
// listener on every request, so toggling/renaming a trigger never needs to
// restart it. httpTriggered tracks each function's currently-registered name
// so a rename or disable knows which route entry to remove.
const httpRoutes = new Map(); // name -> functionId
const httpTriggered = new Map(); // functionId -> name
let httpListener = null; // { server, stop } | null
let httpListenerStarting = null; // in-flight start Promise, deduplicates concurrent enables
let httpStatus = { state: 'idle', lastError: null, lastPolledAt: null };

function status(functionId) {
  if (running.has(functionId)) return running.get(functionId).status;
  if (httpTriggered.has(functionId)) return httpStatus;
  return { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  for (const id of httpTriggered.keys()) out[id] = httpStatus;
  return out;
}

async function startFor(fn) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = {
    queueName: fn.trigger.queueName,
    status: st,
    cancelled: false,
    stop: () => { record.cancelled = true; },
  };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('elasticmq', { auto: false });
    if (record.cancelled) return;
    if (!store.get(fn.id)) {
      // Function was deleted while ElasticMQ was starting up; deleteFunction's
      // manager.stop(id) was a no-op since nothing was in `running` yet. Clean
      // up instead of starting a poller for a function that no longer exists.
      running.delete(fn.id);
      return;
    }
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'ElasticMQ failed to start' });
      return;
    }
    const handle = sqs.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    if (record.cancelled) {
      handle.stop();
      return;
    }
    record.stop = handle.stop;
  } catch (err) {
    if (!record.cancelled) Object.assign(st, { state: 'error', lastError: err.message });
  }
}

function stopSqs(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

function stopHttpListenerIfIdle() {
  if (httpRoutes.size === 0 && httpListener) {
    httpListener.stop();
    httpListener = null;
    httpStatus = { state: 'idle', lastError: null, lastPolledAt: null };
  }
}

function stopHttp(functionId) {
  const name = httpTriggered.get(functionId);
  if (name === undefined) return;
  httpRoutes.delete(name);
  httpTriggered.delete(functionId);
  stopHttpListenerIfIdle();
}

function stop(functionId) {
  stopSqs(functionId);
  stopHttp(functionId);
}

async function ensureHttpListenerRunning() {
  if (httpListener) return;
  if (httpListenerStarting) return httpListenerStarting;
  httpListenerStarting = (async () => {
    try {
      httpListener = await httpTrigger.createListener({
        resolveFunctionId: (name) => httpRoutes.get(name) ?? null,
        invokeFunction: require('../api/invoke').invokeFunction,
        onError: (err) => { httpStatus = { state: 'error', lastError: err.message, lastPolledAt: null }; },
      });
      httpStatus = { state: 'listening', lastError: null, lastPolledAt: null };
    } catch (err) {
      httpStatus = { state: 'error', lastError: err.message, lastPolledAt: null };
    } finally {
      httpListenerStarting = null;
    }
  })();
  return httpListenerStarting;
}

async function syncHttp(fn) {
  const current = httpTriggered.get(fn.id);
  if (current !== undefined && current !== fn.name) httpRoutes.delete(current);
  httpRoutes.set(fn.name, fn.id);
  httpTriggered.set(fn.id, fn.name);
  await ensureHttpListenerRunning();
}

async function sync(fn) {
  const trigger = fn.trigger;
  // Clean up any stale registration under the *other* trigger type first —
  // covers switching sqs <-> http on the same function.
  if (trigger?.type !== 'http' && httpTriggered.has(fn.id)) stopHttp(fn.id);
  if (trigger?.type !== 'sqs' && running.has(fn.id)) stopSqs(fn.id);

  if (trigger?.type === 'sqs') {
    const shouldRun = !!trigger.enabled;
    const current = running.get(fn.id);
    if (!shouldRun) {
      if (current) stopSqs(fn.id);
      return;
    }
    if (current && current.queueName === trigger.queueName && current.status.state !== 'error') return;
    if (current) stopSqs(fn.id);
    await startFor(fn);
    return;
  }

  if (trigger?.type === 'http') {
    if (!trigger.enabled) { stopHttp(fn.id); return; }
    await syncHttp(fn);
  }
}

async function resumeAll() {
  for (const fn of store.list()) await sync(fn);
}

function stopAll() {
  for (const id of running.keys()) stopSqs(id);
  for (const id of httpTriggered.keys()) stopHttp(id);
}

module.exports = { sync, stop, resumeAll, stopAll, status, statusAll };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/trigger-manager.test.js`
Expected: PASS — every pre-existing SQS test plus the 7 new HTTP ones.

Also run the full server suite once here to catch any regression in the other trigger-related tests:

Run: `node --test --test-concurrency=1 tests/api.test.js tests/trigger-manager.test.js tests/trigger-sqs.test.js tests/http-trigger.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/trigger/manager.js tests/trigger-manager.test.js
git commit -m "feat(trigger): wire the shared HTTP listener into the trigger manager"
```

---

## Task 5: End-to-end test against the real fixture, and the README

**Files:**
- Create: `tests/http-trigger-e2e.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `server/api` (`createFunction`, `updateFunction`, `listHistory`), `server/trigger/manager` (`stop`) — both already exported. `fixtures/typescript/apigw` (existing, untouched — `dist/index.js` is already committed, so no build step is needed; register it with `runtime: 'node'`, `handler: 'dist/index.handler'`).

- [ ] **Step 1: Write the failing test**

Create `tests/http-trigger-e2e.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-http-e2e-'));
const api = require('../server/api');
const manager = require('../server/trigger/manager');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function request(pathAndQuery, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port: 9500, host: '127.0.0.1', path: pathAndQuery, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// updateFunction() fires manager.sync(fn) as fire-and-forget, which starts
// the shared listener asynchronously — retry until it's actually accepting
// connections, the same pattern tests/trigger-docker.test.js uses while
// waiting for ElasticMQ.
async function retryUntilReachable(action, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await action();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

test('enabling an HTTP trigger makes the function reachable over HTTP and tags history', async () => {
  const created = api.createFunction({
    name: 'http-e2e', path: path.join(FIXTURES, 'typescript/apigw'), runtime: 'node',
    handler: 'dist/index.handler',
  });
  const fn = api.updateFunction(created.body.id, { trigger: { type: 'http', enabled: true } }).body;
  try {
    const res = await retryUntilReachable(() => request(`/${fn.name}/hello?name=you`));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { message: 'hello, you (typescript)' });

    const entries = api.listHistory(fn.id).body.entries;
    assert.strictEqual(entries[0].source.type, 'trigger');
    assert.strictEqual(entries[0].source.method, 'GET');
    assert.strictEqual(entries[0].ok, true);
  } finally {
    manager.stop(fn.id);
  }
});

test('a POST body round-trips to the handler and back', async () => {
  const created = api.createFunction({
    name: 'http-e2e-post', path: path.join(FIXTURES, 'typescript/apigw'), runtime: 'node',
    handler: 'dist/index.handler',
  });
  const fn = api.updateFunction(created.body.id, { trigger: { type: 'http', enabled: true } }).body;
  try {
    await retryUntilReachable(() => request(`/${fn.name}/hello`));
    const res = await request(`/${fn.name}/sum`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2,3]',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { sum: 6 });
  } finally {
    manager.stop(fn.id);
  }
});

test('a name with no registered HTTP trigger responds 404; a route the handler itself rejects passes that through', async () => {
  const created = api.createFunction({
    name: 'http-e2e-404', path: path.join(FIXTURES, 'typescript/apigw'), runtime: 'node',
    handler: 'dist/index.handler',
  });
  const fn = api.updateFunction(created.body.id, { trigger: { type: 'http', enabled: true } }).body;
  try {
    await retryUntilReachable(() => request(`/${fn.name}/hello`));

    const noRoute = await request('/no-such-function/hello');
    assert.strictEqual(noRoute.status, 404);
    assert.match(JSON.parse(noRoute.body).error, /no function registered/);

    const notMatched = await request(`/${fn.name}/does-not-match-any-fixture-route`);
    assert.strictEqual(notMatched.status, 404);
    assert.deepStrictEqual(JSON.parse(notMatched.body), { error: 'not found' });
  } finally {
    manager.stop(fn.id);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/http-trigger-e2e.test.js`
Expected: currently should already pass function creation but FAIL on the HTTP requests (`ECONNREFUSED` — nothing is listening on 9500 yet, since this task hasn't changed any runtime code, only added the test — this is expected, it's exercising the already-implemented Task 4 wiring for the first time against a real fixture). If Tasks 1-4 were done correctly, this should actually PASS already; treat any failure here as a real integration bug to fix, not something to implement fresh.

- [ ] **Step 3: Fix anything the end-to-end test surfaces**

There's no new implementation code expected in this step — Tasks 1-4 already implement everything this test exercises. If the test fails, read the failure carefully: it's exercising the full stack together (real function registration, real `manager.sync`, the real listener on the real port, the real `fixtures/typescript/apigw` handler) for the first time, so it can catch integration mistakes the mocked unit tests couldn't (e.g. a wrong field name in the event the fixture actually reads). Fix the root cause in whichever of `server/trigger/http.js`, `server/trigger/manager.js`, or `server/api/functions.js` is wrong, then re-run.

Also update `README.md`: insert a new paragraph immediately after the existing SQS trigger paragraph (the one ending "...enable the trigger in Settings to see it fire on incoming messages."), before the "A project can declare its services..." paragraph:

```markdown
A function can also be reached over plain HTTP from another app, instead of
only fired by SQS: open its Settings, set the trigger type to "HTTP (API
Gateway)", and enable it. Every function with an enabled HTTP trigger shares
one listener at `http://localhost:9500`, routed by the function's name —
`http://localhost:9500/<name>/<...anything>` calls the handler with an API
Gateway HTTP API (payload v2) event (`rawPath`, `requestContext.http.method`,
`queryStringParameters`, `body`) and returns whatever `{statusCode, headers,
body}` it returns as the real HTTP response. Because the route is the
function's name, names must be unique — the playground now rejects a
duplicate outright. See `fixtures/typescript/apigw` for a worked example:
enable the trigger on it and try `curl "localhost:9500/<name>/hello?name=you"`
or `curl -X POST localhost:9500/<name>/sum -d '[1,2,3]'`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/http-trigger-e2e.test.js`
Expected: PASS (all 3 tests).

Then run the full server suite:

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/http-trigger-e2e.test.js README.md
git commit -m "test(trigger): add end-to-end coverage for the HTTP trigger; document it"
```

---

## Task 6: Web types and the trigger status badge's "listening" state

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/trigger-status-badge.tsx`
- Test: `web/src/components/trigger-status-badge.test.tsx`

**Interfaces:**
- Produces: `FunctionTrigger` becomes a union (`{ type: 'sqs'; queueName: string; enabled: boolean } | { type: 'http'; enabled: boolean }`); `TriggerStatus['state']` gains `'listening'`; `InvokeSource` gains `{ type: 'trigger'; method: string; path: string }` alongside the existing two variants.

- [ ] **Step 1: Write the failing test**

Append to `web/src/components/trigger-status-badge.test.tsx`:

```tsx
it('shows the listening state', () => {
  render(<TriggerStatusBadge status={{ state: 'listening', lastError: null, lastPolledAt: null }} />)
  expect(screen.getByText('Trigger: listening')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web run test -- trigger-status-badge`
Expected: FAIL — TypeScript rejects `state: 'listening'` (not yet a valid `TriggerStatus['state']`), and even ignoring types, `STATE_LABEL`/`STATE_CLASS` don't have a `'listening'` entry so the component would throw or render `undefined`.

- [ ] **Step 3: Implement**

In `web/src/lib/types.ts`, replace:

```ts
export interface FunctionTrigger {
  type: 'sqs'
  queueName: string
  enabled: boolean
}
```

with:

```ts
export type FunctionTrigger =
  | { type: 'sqs'; queueName: string; enabled: boolean }
  | { type: 'http'; enabled: boolean }
```

Replace:

```ts
export interface TriggerStatus {
  state: 'idle' | 'polling' | 'error'
  lastError: string | null
  lastPolledAt: number | null
}
```

with:

```ts
export interface TriggerStatus {
  state: 'idle' | 'polling' | 'listening' | 'error'
  lastError: string | null
  lastPolledAt: number | null
}
```

Replace:

```ts
export type InvokeSource = { type: 'manual' } | { type: 'trigger'; messageId: string }
```

with:

```ts
export type InvokeSource =
  | { type: 'manual' }
  | { type: 'trigger'; messageId: string }
  | { type: 'trigger'; method: string; path: string }
```

In `web/src/components/trigger-status-badge.tsx`, replace both maps:

```ts
const STATE_LABEL: Record<TriggerStatus['state'], string> = {
  idle: 'Trigger: idle',
  polling: 'Trigger: polling',
  listening: 'Trigger: listening',
  error: 'Trigger: error',
}

const STATE_CLASS: Record<TriggerStatus['state'], string> = {
  idle: 'border-transparent bg-muted text-muted-foreground',
  polling: 'border-transparent bg-success/15 text-success',
  listening: 'border-transparent bg-success/15 text-success',
  error: 'border-transparent bg-destructive/15 text-destructive',
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix web run test -- trigger-status-badge`
Expected: PASS (3 tests).

Also run the web typecheck, since `FunctionTrigger` becoming a union can surface call sites that assumed `queueName` always exists:

Run: `npm --prefix web run typecheck`
Expected: FAILS at this point — `web/src/components/settings-dialog.tsx` still reads `fn.trigger?.queueName` unconditionally, which TypeScript now rejects on the `{ type: 'http' }` branch of the union. That's expected; Task 7 fixes it. Confirm the *only* errors reported are in `settings-dialog.tsx`/`settings-dialog.test.tsx` before moving on — anything else is an unrelated regression to fix now.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/components/trigger-status-badge.tsx web/src/components/trigger-status-badge.test.tsx
git commit -m "feat(web): add the http trigger type and the listening status state"
```

---

## Task 7: Settings dialog trigger-type selector

**Files:**
- Modify: `web/src/components/settings-dialog.tsx`
- Modify: `web/src/test/setup.ts`
- Test: `web/src/components/settings-dialog.test.tsx`

**Interfaces:**
- Consumes: `FunctionTrigger`, `FunctionDef` (Task 6); `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` from `@/components/ui/select` (existing component, already used by `web/src/components/env-file-picker.tsx`).

- [ ] **Step 1: Add jsdom polyfills the Select component needs under test**

Radix's `Select` (used here for the first time in a test) calls `hasPointerCapture`, `releasePointerCapture`, and `scrollIntoView` when opening/closing — none of which jsdom implements, so a click on the trigger throws deep inside Radix instead of doing anything a test can observe. Add to `web/src/test/setup.ts`, after the existing `ResizeObserver` stub:

```ts
// jsdom doesn't implement pointer capture or scrollIntoView, both of which
// Radix's Select touches when opening/closing — without these, clicking a
// Select trigger throws from inside Radix rather than opening the listbox.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
```

This has no test of its own — it's infrastructure the rest of this task's tests depend on. Its effect is verified by Step 4 below passing.

- [ ] **Step 2: Write the failing tests**

In `web/src/components/settings-dialog.test.tsx`, replace the existing `'saves the trigger config through the patch'` test with:

```tsx
it('saves the trigger config through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'SQS queue' }))
  await user.type(screen.getByLabelText('SQS trigger queue'), 'new-queue')
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({
    trigger: { type: 'sqs', queueName: 'new-queue', enabled: true },
  }))
})
```

Then append these new tests at the end of the file:

```tsx
it('seeds an http trigger and shows its computed URL', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openSettings()
  expect(screen.getByLabelText('HTTP trigger URL')).toHaveValue('http://localhost:9500/test/...')
  expect(screen.getByRole('checkbox', { name: /invoke automatically/i })).toBeChecked()
})

it('saves an http trigger through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'HTTP (API Gateway)' }))
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({
    trigger: { type: 'http', enabled: true },
  }))
})

it('clears the trigger when switched back to None', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'http', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.click(screen.getByRole('combobox', { name: 'Trigger' }))
  await user.click(await screen.findByRole('option', { name: 'None' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({ trigger: null }))
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix web run test -- settings-dialog`
Expected: FAIL — there's no "Trigger" combobox yet, and `fn.trigger?.queueName` still fails to typecheck for the `http` branch (from Task 6).

- [ ] **Step 4: Implement the type selector**

Replace `web/src/components/settings-dialog.tsx` in full with:

```tsx
import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const HTTP_TRIGGER_PORT = 9500 // must match server/trigger/http.js's PORT

type TriggerType = 'none' | 'sqs' | 'http'

export function SettingsDialog({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(fn.name)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const [buildCommand, setBuildCommand] = useState(fn.buildCommand ?? '')
  const [triggerType, setTriggerType] = useState<TriggerType>(fn.trigger?.type ?? 'none')
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
  const [triggerEnabled, setTriggerEnabled] = useState(fn.trigger?.enabled ?? false)
  const update = useUpdateFunction()

  useEffect(() => {
    // Re-seed from `fn` whenever the dialog opens, not just when the `fn`
    // object identity changes. React Query's structural sharing keeps the
    // same `fn` reference across a refetch that changes nothing (e.g. a
    // blank-name save that falls back to the current name), so relying on
    // `fn` alone left a stale, blank Name field the next time the dialog
    // was reopened even though the saved name was correct.
    if (!open) return
    setName(fn.name)
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
    setBuildCommand(fn.buildCommand ?? '')
    setTriggerType(fn.trigger?.type ?? 'none')
    setTriggerQueueName(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
    setTriggerEnabled(fn.trigger?.enabled ?? false)
  }, [open, fn])

  function save() {
    // Empty/garbage input (NaN) keeps the current value; an explicit 0 clamps
    // up to the minimum rather than silently reverting. A blank name keeps
    // the current name by the same rule.
    const t = parseInt(timeoutMs, 10)
    const m = parseInt(memoryMb, 10)
    update.mutate(
      {
        id: fn.id,
        patch: {
          name: name.trim() || fn.name,
          handler: handler.trim(),
          timeoutMs: Math.max(100, Number.isNaN(t) ? fn.timeoutMs : t),
          memoryMb: Math.max(128, Number.isNaN(m) ? fn.memoryMb : m),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
          buildCommand: buildCommand.trim(),
          trigger: triggerType === 'sqs'
            ? (triggerQueueName.trim()
              ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled: triggerEnabled }
              : null)
            : triggerType === 'http'
              ? { type: 'http', enabled: triggerEnabled }
              : null,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-handler">Handler</Label>
            <Input id="s-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-timeout">Timeout (ms)</Label>
            <Input id="s-timeout" type="number" min={100} step={1000} value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-memory">Memory (MB)</Label>
            <Input id="s-memory" type="number" min={128} step={64} value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)} />
          </div>
          {fn.runtime === 'java' && (
            <div className="grid gap-2">
              <Label htmlFor="s-jar">Jar path</Label>
              <Input id="s-jar" value={jarPath} onChange={(e) => setJarPath(e.target.value)}
                spellCheck={false} placeholder="auto-detected if empty" />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="s-build">Build command</Label>
            <Input id="s-build" value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              spellCheck={false} placeholder="e.g. npm run build (empty = none)" />
            <p className="text-xs text-muted-foreground">
              Runs in the project folder before every invoke.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-trigger-type">Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
              <SelectTrigger id="s-trigger-type" size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="sqs">SQS queue</SelectItem>
                <SelectItem value="http">HTTP (API Gateway)</SelectItem>
              </SelectContent>
            </Select>
            {triggerType === 'sqs' && (
              <>
                <Label htmlFor="s-trigger-queue">SQS trigger queue</Label>
                <Input id="s-trigger-queue" value={triggerQueueName}
                  onChange={(e) => setTriggerQueueName(e.target.value)}
                  spellCheck={false} placeholder="queue name (empty = no trigger)" />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={triggerEnabled} disabled={!triggerQueueName.trim()}
                    onCheckedChange={(v) => setTriggerEnabled(v === true)} />
                  Invoke automatically when a message arrives
                </label>
                <p className="text-xs text-muted-foreground">
                  Auto-starts the local SQS service (ElasticMQ) and creates the queue if it doesn't exist.
                </p>
              </>
            )}
            {triggerType === 'http' && (
              <>
                <Label htmlFor="s-trigger-url">HTTP trigger URL</Label>
                <Input id="s-trigger-url" readOnly
                  value={`http://localhost:${HTTP_TRIGGER_PORT}/${name.trim() || fn.name}/...`}
                  spellCheck={false} onFocus={(e) => e.target.select()} />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={triggerEnabled}
                    onCheckedChange={(v) => setTriggerEnabled(v === true)} />
                  Invoke automatically on incoming requests
                </label>
                <p className="text-xs text-muted-foreground">
                  Shares one listener on port {HTTP_TRIGGER_PORT} across every function with an
                  HTTP trigger enabled, routed by name — names must be unique.
                </p>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web run test -- settings-dialog`
Expected: PASS — every pre-existing test (the `'seeds the trigger fields from the function'` and `'clears the trigger when the queue name is left blank'` tests need no changes: both render with `fn.trigger.type === 'sqs'` already set, so `triggerType` initializes to `'sqs'` and the queue-name field is visible immediately) plus the new HTTP tests.

Then confirm the typecheck failure from Task 6 is now resolved:

Run: `npm --prefix web run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings-dialog.tsx web/src/components/settings-dialog.test.tsx web/src/test/setup.ts
git commit -m "feat(web): add an HTTP trigger option to the settings dialog"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (`npm run test:server` then `npm run test:web`).

- [ ] **Step 2: Run the web typecheck and build**

Run: `npm --prefix web run typecheck && npm run build`
Expected: both succeed; `npm run build` regenerates `web/dist` so the new Settings UI ships in `npx github:...`/`npm start`.

- [ ] **Step 3: Run the linter**

Run: `npm run lint`
Expected: PASS. Fix anything oxlint flags in the files this plan touched before moving on.

- [ ] **Step 4: Manual smoke test**

Run: `npm start`. In the browser: register `fixtures/typescript/apigw` (handler `dist/index.handler`, runtime Node), open its Settings, set the Trigger dropdown to "HTTP (API Gateway)", copy the shown URL, and enable it. In a terminal, run `curl "http://localhost:9500/<name>/hello?name=you"` and confirm it returns `{"message":"hello, you (typescript)"}`; confirm the invoke shows up in the History tab tagged "trigger". Disable the trigger and confirm the same `curl` now fails to connect (or 404s if another enabled function still holds the port).

This step has no automated pass/fail — note in your final report whether you performed it and what you observed.
