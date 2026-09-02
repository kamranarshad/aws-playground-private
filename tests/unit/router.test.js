const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { handleApiRequest } = require('../../server/api/router');

function makeTestServer() {
  const server = http.createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Handled');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

test('handleApiRequest handles health and non-api routes', async () => {
  const app = await makeTestServer();
  try {
    // Non-API route should return false (404 Not Handled in our test server)
    const nonApi = await fetch(`${app.url}/something-else`);
    assert.strictEqual(nonApi.status, 404);
    assert.strictEqual(await nonApi.text(), 'Not Handled');

    // Health endpoint
    const health = await fetch(`${app.url}/api/health`);
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.ok(body.runtimes);

    // Unknown API route should return 404 JSON
    const unknown = await fetch(`${app.url}/api/unknown-endpoint`);
    assert.strictEqual(unknown.status, 404);
    const unknownBody = await unknown.json();
    assert.ok(unknownBody.error);

    // Stats endpoint for non-existent function returns 404
    const stats404 = await fetch(`${app.url}/api/functions/non-existent-id/stats`);
    assert.strictEqual(stats404.status, 404);
  } finally {
    app.close();
  }
});

