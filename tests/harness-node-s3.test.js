const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'node', 'harness.mjs');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'typescript/node-s3');
const built = fs.existsSync(path.join(FIXTURE, 'dist', 'index.js'));

// Minimal in-memory S3 stub (path-style): CreateBucket, PutObject,
// GetObject (404 NoSuchKey when absent), ListObjectsV2. Ignores SigV4.
let server, endpoint;
const objects = new Map(); // key -> body string

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => resolve(b));
  });
}

before(() => new Promise((resolve) => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // [bucket, ...key]
    const key = parts.slice(1).join('/');

    if (req.method === 'PUT' && !key) { // CreateBucket
      res.writeHead(200); return res.end();
    }
    if (req.method === 'PUT') { // PutObject
      objects.set(key, await readBody(req));
      res.writeHead(200); return res.end();
    }
    if (req.method === 'GET' && url.searchParams.has('list-type')) { // ListObjectsV2
      const contents = [...objects.keys()]
        .map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
    }
    if (req.method === 'GET') { // GetObject
      if (objects.has(key)) {
        res.writeHead(200); return res.end(objects.get(key));
      }
      res.writeHead(404, { 'content-type': 'application/xml' });
      return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
    }
    res.writeHead(400); res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    endpoint = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

function runHarness(event) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hs3-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', 'dist/index.handler', '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-s3'],
      { cwd: FIXTURE, env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        AWS_ENDPOINT_URL_S3: endpoint,
        AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1',
      } },
      () => {
        let envelope = null;
        try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); fs.unlinkSync(resultFile); } catch {}
        resolve(envelope);
      });
    child.stdin.end(JSON.stringify(event));
  });
}

test('ts-node-s3: put then get round-trips via the injected endpoint',
  { skip: built ? false : 'fixture dist not built' }, async () => {
  const put = await runHarness({ action: 'put', key: 'a.txt', body: 'hello s3' });
  assert.strictEqual(put.ok, true);
  assert.strictEqual(put.response.action, 'put');
  assert.strictEqual(put.response.bytes, 8);

  const get = await runHarness({ action: 'get', key: 'a.txt' });
  assert.strictEqual(get.response.ok, true);
  assert.strictEqual(get.response.body, 'hello s3');
});

test('ts-node-s3: missing key returns NoSuchKey',
  { skip: built ? false : 'fixture dist not built' }, async () => {
  const get = await runHarness({ action: 'get', key: 'nope.txt' });
  assert.strictEqual(get.response.ok, false);
  assert.strictEqual(get.response.error, 'NoSuchKey');
});

test('ts-node-s3: list returns stored keys',
  { skip: built ? false : 'fixture dist not built' }, async () => {
  await runHarness({ action: 'put', key: 'b.txt', body: 'x' });
  const list = await runHarness({ action: 'list' });
  assert.strictEqual(list.response.ok, true);
  assert.ok(list.response.keys.includes('b.txt'));
});
