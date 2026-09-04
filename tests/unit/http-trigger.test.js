const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-http-data-'));

const httpTrigger = require('../../server/trigger/http');
const store = require('../../server/persistence/store');
const originalCreateListener = httpTrigger.createListener;
const {
  routeFor, encodeBody, buildHttpEvent, isValidProxyResponse, translateInvokeResult,
} = httpTrigger;

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
  assert.strictEqual(event.version, '2.0');
});

test('buildHttpEvent omits queryStringParameters when there is no query string', () => {
  const url = new URL('http://internal/hello');
  const event = buildHttpEvent({ method: 'GET', rawPath: '/hello', url, headers: {}, bodyBuffer: Buffer.alloc(0) });
  assert.strictEqual(event.queryStringParameters, undefined);
  assert.strictEqual(event.rawQueryString, '');
});

test('buildHttpEvent shapes an API Gateway REST API v1 event when format is v1', () => {
  const url = new URL('http://internal/hello?name=you');
  const event = buildHttpEvent({
    method: 'POST', rawPath: '/hello', url, headers: { host: 'localhost' },
    bodyBuffer: Buffer.from('{"test":1}'), format: 'v1',
  });
  assert.strictEqual(event.path, '/hello');
  assert.strictEqual(event.httpMethod, 'POST');
  assert.strictEqual(event.resource, '/{proxy+}');
  assert.deepStrictEqual(event.queryStringParameters, { name: 'you' });
  assert.strictEqual(event.body, '{"test":1}');
  assert.strictEqual(event.isBase64Encoded, false);
  assert.strictEqual(event.requestContext.httpMethod, 'POST');
});

test('isValidProxyResponse accepts a minimal proxy response and rejects malformed shapes', () => {
  assert.strictEqual(isValidProxyResponse({ statusCode: 200 }), true);
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, body: 'x', headers: { a: 'b' } }), true);
  assert.strictEqual(isValidProxyResponse(null), false);
  assert.strictEqual(isValidProxyResponse({}), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: '200' }), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, body: 123 }), false);
});

test('isValidProxyResponse rejects a statusCode outside the valid HTTP range', () => {
  assert.strictEqual(isValidProxyResponse({ statusCode: 99 }), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: 600 }), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: 599 }), true);
  assert.strictEqual(isValidProxyResponse({ statusCode: 100 }), true);
});

test('isValidProxyResponse rejects non-string header values', () => {
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, headers: { 'x-a': { nested: true } } }), false);
  assert.strictEqual(isValidProxyResponse({ statusCode: 200, headers: { 'x-a': 'ok' } }), true);
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

test('translateInvokeResult surfaces a string-shaped error (not just {message})', () => {
  const r = translateInvokeResult({ status: 200, body: { ok: false, error: 'MinIO is not running' } });
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(JSON.parse(r.bodyBuffer), { error: 'handler error', detail: 'MinIO is not running' });
});

test('translateInvokeResult strips framing headers a handler tries to set directly', () => {
  const r = translateInvokeResult({
    status: 200,
    body: { ok: true, response: { statusCode: 200, headers: { 'Content-Length': '999', 'x-real': 'kept' }, body: 'hi' } },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-real'], 'kept');
  assert.strictEqual('Content-Length' in r.headers, false);
  assert.strictEqual('content-length' in r.headers, false);
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
const { createListener } = require('../../server/trigger/http');

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

test('the listener responds 502 (not 500) when the handler returns an out-of-range status code', async () => {
  const listener = await createListener({
    port: 0, resolveFunctionId: () => 'fn-id-1',
    invokeFunction: async () => ({ status: 200, body: { ok: true, response: { statusCode: 99, body: 'x' } } }),
  });
  try {
    const port = listener.server.address().port;
    const res = await request(port, '/myfn/hello');
    assert.strictEqual(res.status, 502);
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

// sync/stop/status: the shared-listener state machine. createListener is
// monkeypatched throughout so none of this binds a real socket.

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

    await httpTrigger.sync(fn, fn.trigger);

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(httpTrigger.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    httpTrigger.stop(fn.id);
    assert.strictEqual(stopped, true);
    assert.strictEqual(httpTrigger.status(fn.id), undefined);
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

    await httpTrigger.sync(a, a.trigger);
    await httpTrigger.sync(b, b.trigger);
    assert.strictEqual(calls, 1);

    httpTrigger.stop(a.id);
    assert.deepStrictEqual(httpTrigger.status(b.id), { state: 'listening', lastError: null, lastPolledAt: null });
    httpTrigger.stop(b.id);
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

    const p1 = httpTrigger.sync(a, a.trigger);
    const p2 = httpTrigger.sync(b, b.trigger);
    resolveStart();
    await Promise.all([p1, p2]);

    assert.strictEqual(calls, 1);
    httpTrigger.stop(a.id);
    httpTrigger.stop(b.id);
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
    await httpTrigger.sync(fn, fn.trigger);
    fn = store.update(fn.id, { name: 'h4-renamed' });
    await httpTrigger.sync(fn, fn.trigger);

    assert.strictEqual(calls, 1, 'a rename must not restart the shared listener');
    const resolve = registered[0];
    assert.strictEqual(resolve('h4'), null, 'the old name must no longer route');
    assert.strictEqual(resolve('h4-renamed'), fn.id);
    httpTrigger.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('a listener start failure is reported as an error status', async () => {
  httpTrigger.createListener = async () => { throw new Error('EADDRINUSE: address already in use 127.0.0.1:9500'); };
  try {
    const fn = store.create({ name: 'h6', path: '/tmp/h6', runtime: 'node', trigger: { type: 'http', enabled: true } });
    await httpTrigger.sync(fn, fn.trigger);
    const st = httpTrigger.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /EADDRINUSE/);
    httpTrigger.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('a function disabling its http trigger while the shared listener is still starting leaves no listener bound', async () => {
  let stopped = false;
  let resolveStart;
  httpTrigger.createListener = () => new Promise((resolve) => {
    resolveStart = () => resolve({ stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } });
  });
  try {
    const fn = store.create({ name: 'h8', path: '/tmp/h8', runtime: 'node', trigger: { type: 'http', enabled: true } });

    const syncPromise = httpTrigger.sync(fn, fn.trigger); // don't await yet — createListener is still pending
    httpTrigger.stop(fn.id); // race: disable before the listener finishes starting
    resolveStart(); // now let the create resolve, with the route table already empty
    await syncPromise;

    assert.strictEqual(stopped, true, 'the orphaned listener must be stopped once its create resolves');
    assert.strictEqual(httpTrigger.status(fn.id), undefined);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('sync never registers a route for a name containing "/"', async () => {
  let listenerCalls = 0;
  httpTrigger.createListener = async () => {
    listenerCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'has/slash', path: '/tmp/hslash', runtime: 'node' });

    await httpTrigger.sync(fn, { type: 'http', enabled: true });

    assert.strictEqual(listenerCalls, 0, 'no listener should ever start for an unroutable name');
    assert.strictEqual(httpTrigger.status(fn.id), undefined);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});
