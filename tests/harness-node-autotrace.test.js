const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-autotrace-e2e-'));
const { invoke } = require('../server/invoker');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'javascript', 'auto-trace-http');

function withTestServer(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { res.end('pong'); });
    server.listen(0, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      try {
        resolve(await fn(url));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('a plain CommonJS handler with no OTel code gets a real auto-instrumented span', async () => {
  await withTestServer(async (url) => {
    const r = await invoke({
      id: 'fn-autotrace-e2e', name: 'autotrace-e2e', dir: FIXTURE, runtime: 'node',
      handler: 'index.handler', event: { url }, autoTrace: true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.response.body, 'pong');
    assert.ok(r.trace.spans.length >= 1, `expected at least one auto-instrumented span, got ${r.trace.spans.length}`);
    const httpSpan = r.trace.spans.find((s) => s.name === 'GET');
    assert.ok(httpSpan, `expected a span named "GET" from the http instrumentation, got names: ${r.trace.spans.map((s) => s.name).join(', ')}`);
  });
});

test('the same handler with autoTrace off produces no spans', async () => {
  await withTestServer(async (url) => {
    const r = await invoke({
      id: 'fn-autotrace-off-e2e', name: 'autotrace-off-e2e', dir: FIXTURE, runtime: 'node',
      handler: 'index.handler', event: { url }, autoTrace: false,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.trace.spans.length, 0);
  });
});
