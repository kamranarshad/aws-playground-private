const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-http-e2e-'));
const api = require('../../server/api');
const manager = require('../../server/trigger/manager');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

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
