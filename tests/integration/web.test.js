const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'web', 'dist');
const built = fs.existsSync(path.join(DIST, 'server', 'server.js')) ||
  fs.existsSync(path.join(DIST, 'index.html')) ||
  fs.existsSync(path.join(DIST, 'client', 'index.html'));

test('built web app serves the shell and the API',
  { skip: built ? false : 'web/dist missing - run npm run build first' }, async () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-web-'));
  const { startWebServer } = require('../../server/serve-web');
  const server = await startWebServer({ distDir: DIST, port: 0, host: '127.0.0.1' });
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.ok(body.runtimes.node.available);

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.ok(html.includes('Lambda Playground'));

    const fns = await fetch(`http://127.0.0.1:${port}/api/functions`);
    assert.deepStrictEqual(await fns.json(), { functions: [] });

    const missing = await fetch(`http://127.0.0.1:${port}/api/functions/nope/history`);
    assert.strictEqual(missing.status, 404);

    const fixtureDir = path.join(__dirname, '..', '..', 'fixtures', 'javascript/apigw');
    const created = await fetch(`http://127.0.0.1:${port}/api/functions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke', path: fixtureDir, runtime: 'node', handler: 'index.handler' }),
    });
    assert.strictEqual(created.status, 201);
    const fn = await created.json();

    const patched = await fetch(`http://127.0.0.1:${port}/api/functions/${fn.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutMs: 5000 }),
    });
    assert.strictEqual(patched.status, 200);
    const patchedFn = await patched.json();
    assert.strictEqual(patchedFn.timeoutMs, 5000);

    const event = JSON.parse(fs.readFileSync(
      path.join(fixtureDir, 'events', 'get-hello.json'), 'utf8'));
    const invoked = await fetch(`http://127.0.0.1:${port}/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ functionId: fn.id, event }),
    });
    assert.strictEqual(invoked.status, 200);
    const invokedBody = await invoked.json();
    assert.strictEqual(invokedBody.ok, true);
    assert.strictEqual(invokedBody.response.statusCode, 200);

    const historyRes = await fetch(`http://127.0.0.1:${port}/api/functions/${fn.id}/history`);
    assert.strictEqual(historyRes.status, 200);
    const historyBody = await historyRes.json();
    assert.strictEqual(historyBody.entries.length, 1);

    const statsRes = await fetch(`http://127.0.0.1:${port}/api/functions/${fn.id}/stats`);
    assert.strictEqual(statsRes.status, 200);
    const statsBody = await statsRes.json();
    assert.strictEqual(statsBody.total, 1);
    assert.strictEqual(statsBody.successes, 1);
    assert.strictEqual(statsBody.errorRate, 0);

    const deleted = await fetch(`http://127.0.0.1:${port}/api/functions/${fn.id}`, { method: 'DELETE' });
    assert.strictEqual(deleted.status, 204);
    const deletedAgain = await fetch(`http://127.0.0.1:${port}/api/functions/${fn.id}`, { method: 'DELETE' });
    assert.strictEqual(deletedAgain.status, 404);
  } finally {
    server.close();
  }
});

test('static SPA mode serves index.html on client-route fallback', async () => {
  const spaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-spa-'));
  fs.writeFileSync(path.join(spaDir, 'index.html'), '<!DOCTYPE html><html><body>SPA Shell</body></html>');
  fs.writeFileSync(path.join(spaDir, 'style.css'), 'body { background: black; }');
  const { startWebServer } = require('../../server/serve-web');
  const server = await startWebServer({ distDir: spaDir, port: 0, host: '127.0.0.1' });
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(health.status, 200);

    const css = await fetch(`http://127.0.0.1:${port}/style.css`);
    assert.strictEqual(css.status, 200);
    assert.strictEqual(css.headers.get('content-type'), 'text/css');

    // Route fallback to index.html for client route
    const clientRoute = await fetch(`http://127.0.0.1:${port}/services`);
    assert.strictEqual(clientRoute.status, 200);
    const html = await clientRoute.text();
    assert.ok(html.includes('SPA Shell'));
  } finally {
    server.close();
    fs.rmSync(spaDir, { recursive: true, force: true });
  }
});
