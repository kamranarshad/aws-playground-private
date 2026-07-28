const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { invoke } = require('../server/invoker');
const { hasRuntime } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'java/hello');
const JAR = path.join(FIXTURE, 'target', 'java-hello.jar');
const skip = !hasRuntime('java', ['-version']) || !fs.existsSync(JAR);

function base(extra = {}) {
  return {
    name: 'java-fn', dir: FIXTURE, runtime: 'java', jarPath: JAR,
    handler: 'example.Hello::handleRequest', event: { j: 1 }, ...extra,
  };
}

test('java RequestHandler happy path with proxied context + logger', { skip }, async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
  assert.deepStrictEqual(r.response.echo, { j: 1 });
  assert.strictEqual(r.response.requestId, r.report.requestId);
  assert.ok(r.logs.includes('hello from java logger'));
});

test('class-only handler defaults to handleRequest', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Hello' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
});

test('unknown class -> phase:init', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Nope::handleRequest' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'init');
  assert.strictEqual(r.error.type, 'java.lang.ClassNotFoundException');
});
