const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fe-'));
const { createApp } = require('../server/index');

let server, baseUrl;
before(() => new Promise((resolve) => {
  server = createApp().listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

test('index.html references the app assets', async () => {
  const html = await (await fetch(baseUrl + '/')).text();
  assert.ok(html.includes('Lambda Playground'));
  assert.ok(html.includes('app.js'));
  assert.ok(html.includes('styles.css'));
  assert.ok(html.includes('vendor/codemirror/codemirror.min.js'));
});

test('static assets are served', async () => {
  for (const asset of ['/app.js', '/styles.css', '/vendor/codemirror/codemirror.min.js']) {
    const res = await fetch(baseUrl + asset);
    assert.strictEqual(res.status, 200, asset);
  }
});

test('app.js parses as valid javascript', () => {
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'public', 'app.js')]);
});
