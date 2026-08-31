const http = require('http');
const { PORTS } = require('../../ports');
const { dispatch } = require('./events');

const PORT = PORTS.s3Webhook;
const HOST = '127.0.0.1';

// The HTTP server MinIO posts bucket notifications to. Process-lifetime and
// started from server/bootstrap.js rather than per-trigger, which is why the
// driver in ./index.js only owns the route table it reads.
function createRequestHandler({ routesFor, invokeFunction }) {
  return async function handleRequest(req, res) {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Always 200 once the body is read — MinIO doesn't wait on the actual
    // invoke outcome (see dispatch's fire-and-forget invokeFunction call),
    // and a malformed body is our problem to log, not MinIO's to retry.
    res.writeHead(200);
    res.end();
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return;
    }
    const records = Array.isArray(payload.Records) ? payload.Records : [];
    for (const record of records) {
      try {
        dispatch(record, { routesFor, invokeFunction });
      } catch {
        // Silently drop records that cause dispatch to fail — this fire-and-forget
        // listener must never crash the process or reject a request.
      }
    }
  };
}

// Stateless factory — one shared instance is started once from bin/cli.js
// for the life of the process (unlike server/trigger/http.js's listener,
// which the trigger manager starts/stops based on trigger state), so it
// needs no singleton bookkeeping here.
/**
 * @param {{ routesFor?: (bucket: string) => any, invokeFunction?: (input: any) => Promise<any>,
 *          port?: number, host?: string }} [opts]
 */
function createListener({ routesFor, invokeFunction, port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler({ routesFor, invokeFunction }));
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      // An 'error' emitted after a successful bind (e.g. an accept-queue
      // error) has no listener left to catch it, and an unhandled 'error' on
      // an EventEmitter takes the whole process down. Log it instead — same
      // shape as server/trigger/http.js's post-bind onError re-attachment.
      server.on('error', (err) => {
        console.warn(`aws-playground: S3 webhook listener error: ${err.message}`);
      });
      resolve({ server, stop: () => server.close() });
    });
  });
}

module.exports = { createRequestHandler, createListener, PORT, HOST };
