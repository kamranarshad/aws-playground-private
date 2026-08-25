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
    version: '2.0',
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
    && Number.isInteger(resp.statusCode) && resp.statusCode >= 100 && resp.statusCode <= 599
    && (resp.body === undefined || typeof resp.body === 'string')
    && (resp.headers === undefined || (typeof resp.headers === 'object' && resp.headers !== null
      && Object.values(resp.headers).every((v) => typeof v === 'string' || typeof v === 'number')));
}

// Headers Node computes itself from the response it's sending — a handler
// setting these directly would either be silently overridden (safe) or, for
// content-length specifically, corrupt the HTTP response framing if it
// doesn't match the actual bytes written (not safe), so they're stripped
// rather than passed through.
const FRAMING_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

function stripFramingHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!FRAMING_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
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
    const detail = (typeof inv?.error === 'string' ? inv.error : inv?.error?.message) ?? 'invoke failed';
    return jsonResult(502, { error: 'handler error', detail });
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
  return { status: resp.statusCode, headers: stripFramingHeaders(resp.headers ?? {}), bodyBuffer };
}

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

module.exports = {
  PORT, HOST, routeFor, encodeBody, buildHttpEvent, isValidProxyResponse, translateInvokeResult,
  createRequestHandler, createListener,
};
