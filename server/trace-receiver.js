// A tiny, always-on, loopback-only HTTP server that accepts OTLP/HTTP span
// exports from invoked handlers. Kept separate from the main web server's
// port because that port isn't reliably known here: production picks one
// at startup (bin/cli.js), but dev mode runs entirely inside `vite dev`
// (no bin/cli.js involved), and trigger-invoked calls have no incoming
// HTTP request to read a host from. Same listen(0, ...)-then-read-back-the-
// port pattern harnesses/provided/harness.mjs already uses for its Runtime
// API emulation.
const http = require('http');
const { decodeProtobuf, decodeJson } = require('./otlp-decode');
const traceCollector = require('./trace-collector');

const FAAS_INVOCATION_ID = 'faas.invocation_id';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/traces') {
    res.writeHead(404);
    return res.end();
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let groups;
  try {
    const contentType = req.headers['content-type'] || '';
    groups = contentType.includes('json') ? decodeJson(body.toString('utf8')) : decodeProtobuf(body);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`could not decode OTLP request: ${err.message}`);
  }
  for (const { resourceAttributes, spans } of groups) {
    const requestId = resourceAttributes[FAAS_INVOCATION_ID];
    if (typeof requestId === 'string') traceCollector.ingest(requestId, spans);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
// Doesn't keep the process (or a test file's `node --test` run) alive on
// its own -- it's fine for this listener to still technically be "open"
// when everything else the process was doing has finished.
server.unref();

const readyPromise = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function endpoint() {
  const port = await readyPromise;
  return `http://127.0.0.1:${port}/v1/traces`;
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = { endpoint, close };
