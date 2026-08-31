const { test } = require('node:test');
const assert = require('node:assert');
const { decodeProtobuf, decodeJson } = require('../server/trace/otlp-decode');

// --- minimal protobuf encoder, test-only, mirrors the field numbers the
// production decoder in server/otlp-decode.js reads ---
function writeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    bytes.push(b);
  } while (v !== 0n);
  return Buffer.from(bytes);
}
function tag(fieldNumber, wireType) { return writeVarint((fieldNumber << 3) | wireType); }
function lengthDelimited(fieldNumber, payload) {
  return Buffer.concat([tag(fieldNumber, 2), writeVarint(payload.length), payload]);
}
function stringField(fieldNumber, str) { return lengthDelimited(fieldNumber, Buffer.from(str, 'utf8')); }
function fixed64Field(fieldNumber, n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return Buffer.concat([tag(fieldNumber, 1), buf]);
}
function bytesField(fieldNumber, hex) { return lengthDelimited(fieldNumber, Buffer.from(hex, 'hex')); }

// KeyValue { key: string(1), value: AnyValue(2) }, AnyValue.string_value = field 1
function encodeKeyValue(key, stringValue) {
  return Buffer.concat([stringField(1, key), lengthDelimited(2, stringField(1, stringValue))]);
}
// Span message bytes (no outer tag/len)
function encodeSpan({ traceId, spanId, parentSpanId, name, startNs, endNs, attrs }) {
  const parts = [bytesField(1, traceId), bytesField(2, spanId)];
  if (parentSpanId) parts.push(bytesField(4, parentSpanId));
  parts.push(stringField(5, name), fixed64Field(7, startNs), fixed64Field(8, endNs));
  for (const [k, v] of Object.entries(attrs ?? {})) parts.push(lengthDelimited(9, encodeKeyValue(k, v)));
  return Buffer.concat(parts);
}
// ScopeSpans message bytes: repeated Span at field 2
function encodeScopeSpansMessage(spans) {
  return Buffer.concat(spans.map((s) => lengthDelimited(2, encodeSpan(s))));
}
// Resource message bytes: repeated KeyValue at field 1
function encodeResourceMessage(attrs) {
  return Buffer.concat(Object.entries(attrs).map(([k, v]) => lengthDelimited(1, encodeKeyValue(k, v))));
}
// ResourceSpans message bytes: resource at field1, one ScopeSpans entry at field2
function encodeResourceSpansMessage({ resourceAttrs, spans }) {
  const resourceEntry = lengthDelimited(1, encodeResourceMessage(resourceAttrs));
  const scopeSpansEntry = lengthDelimited(2, encodeScopeSpansMessage(spans));
  return Buffer.concat([resourceEntry, scopeSpansEntry]);
}
// ExportTraceServiceRequest message bytes: resource_spans at field1
function encodeRequest({ resourceAttrs, spans }) {
  return lengthDelimited(1, encodeResourceSpansMessage({ resourceAttrs, spans }));
}

test('decodeProtobuf reads a resource attribute and a span back out', () => {
  const buf = encodeRequest({
    resourceAttrs: { 'faas.invocation_id': 'req-123' },
    spans: [{
      traceId: 'aabbccddeeff00112233445566778899',
      spanId: '0011223344556677',
      parentSpanId: null,
      name: 'do-thing',
      startNs: 1_000_000_000,
      endNs: 1_050_000_000,
      attrs: { 'http.method': 'GET' },
    }],
  });
  const [group] = decodeProtobuf(buf);
  assert.deepStrictEqual(group.resourceAttributes, { 'faas.invocation_id': 'req-123' });
  assert.strictEqual(group.spans.length, 1);
  const [span] = group.spans;
  assert.strictEqual(span.traceId, 'aabbccddeeff00112233445566778899');
  assert.strictEqual(span.spanId, '0011223344556677');
  assert.strictEqual(span.parentSpanId, null);
  assert.strictEqual(span.name, 'do-thing');
  assert.strictEqual(span.startTimeUnixNano, '1000000000');
  assert.strictEqual(span.endTimeUnixNano, '1050000000');
  assert.deepStrictEqual(span.attributes, { 'http.method': 'GET' });
});

test('decodeProtobuf reads a parent span id when present', () => {
  const buf = encodeRequest({
    resourceAttrs: {},
    spans: [{
      traceId: 'aa', spanId: 'bb', parentSpanId: 'cc', name: 'child',
      startNs: 1, endNs: 2, attrs: {},
    }],
  });
  assert.strictEqual(decodeProtobuf(buf)[0].spans[0].parentSpanId, 'cc');
});

test('decodeProtobuf throws on an unsupported wire type', () => {
  // field 1, wire type 3 ("start group") -- deprecated/unsupported in proto3
  assert.throws(() => decodeProtobuf(Buffer.from([0x0b])));
});

test('decodeJson reads the equivalent proto3 JSON mapping', () => {
  const json = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: 'faas.invocation_id', value: { stringValue: 'req-456' } }] },
      scopeSpans: [{
        spans: [{
          traceId: 'aabbcc',
          spanId: '001122',
          name: 'json-span',
          startTimeUnixNano: '2000000000',
          endTimeUnixNano: '2010000000',
          attributes: [{ key: 'ok', value: { boolValue: true } }],
        }],
      }],
    }],
  });
  const [group] = decodeJson(json);
  assert.deepStrictEqual(group.resourceAttributes, { 'faas.invocation_id': 'req-456' });
  assert.strictEqual(group.spans[0].traceId, 'aabbcc');
  assert.strictEqual(group.spans[0].spanId, '001122');
  assert.strictEqual(group.spans[0].name, 'json-span');
  assert.strictEqual(group.spans[0].startTimeUnixNano, '2000000000');
  assert.deepStrictEqual(group.spans[0].attributes, { ok: true });
});

test('decodeJson throws on invalid JSON', () => {
  assert.throws(() => decodeJson('not json'));
});
