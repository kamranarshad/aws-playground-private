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
