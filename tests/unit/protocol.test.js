const { test } = require('node:test');
const assert = require('node:assert');
const {
  encodeRequest, sentinelFor, splitAtSentinel, SENTINEL_PREFIX,
} = require('../../server/runtime/protocol');

test('encodeRequest length-prefixes the payload in bytes, not characters', () => {
  const encoded = encodeRequest({ hello: 'wörld' });
  const nl = encoded.indexOf('\n');
  const header = encoded.slice(0, nl);
  const body = encoded.slice(nl + 1);
  assert.strictEqual(Number(header), Buffer.byteLength(body, 'utf8'));
  assert.deepStrictEqual(JSON.parse(body), { hello: 'wörld' });
});

test('encodeRequest survives a newline inside the payload', () => {
  const encoded = encodeRequest({ body: 'line one\nline two' });
  const nl = encoded.indexOf('\n');
  const body = encoded.slice(nl + 1);
  assert.deepStrictEqual(JSON.parse(body), { body: 'line one\nline two' });
});

test('splitAtSentinel returns null until the whole sentinel has arrived', () => {
  const id = 'abc';
  assert.strictEqual(splitAtSentinel('partial logs', id), null);
  assert.strictEqual(splitAtSentinel('logs' + SENTINEL_PREFIX + 'ab', id), null);
});

test('splitAtSentinel cuts the logs and keeps what follows', () => {
  const id = 'abc';
  const buf = 'hello from the handler\n' + sentinelFor(id) + 'next invoke output';
  assert.deepStrictEqual(splitAtSentinel(buf, id),
    { logs: 'hello from the handler\n', rest: 'next invoke output' });
});

test('splitAtSentinel ignores a sentinel for a different request', () => {
  assert.strictEqual(splitAtSentinel('logs' + sentinelFor('other'), 'abc'), null);
});

test('handler output that merely mentions the marker does not split it early', () => {
  const id = 'abc';
  const buf = 'the marker is AWSPLAY-END:abc apparently\n' + sentinelFor(id);
  const { logs } = splitAtSentinel(buf, id);
  assert.match(logs, /apparently/, 'cut at the plain-text mention instead of the NUL-framed one');
});
