// Minimal, read-only decoder for exactly the OTLP messages this playground
// needs: ExportTraceServiceRequest -> ResourceSpans -> ScopeSpans -> Span,
// plus the common KeyValue/AnyValue/Resource types. The official
// @opentelemetry/otlp-transformer package only implements the exporter side
// (encode a request, decode a response) -- there's no supported decode-a-
// request entry point to reuse, so this hand-rolls just enough of the wire
// format to read the fixed, versioned schema at
// https://github.com/open-telemetry/opentelemetry-proto.

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let b;
  do {
    b = buf[pos.i];
    pos.i += 1;
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return result;
}

// Splits one embedded message's bytes into field-number -> raw-value-list.
// Doesn't know what any field means yet -- the decode* functions below
// interpret specific field numbers; everything else is simply never read.
function splitFields(buf) {
  const fields = new Map();
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    let value;
    if (wireType === 0) {
      value = readVarint(buf, pos);
    } else if (wireType === 1) {
      value = buf.subarray(pos.i, pos.i + 8);
      pos.i += 8;
    } else if (wireType === 2) {
      const len = Number(readVarint(buf, pos));
      value = buf.subarray(pos.i, pos.i + len);
      pos.i += len;
    } else if (wireType === 5) {
      value = buf.subarray(pos.i, pos.i + 4);
      pos.i += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType} (field ${fieldNumber})`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

function toHex(buf) {
  return Buffer.from(buf ?? []).toString('hex');
}

function readFixed64LE(buf) {
  return buf ? buf.readBigUInt64LE(0).toString() : '0';
}

function decodeAnyValue(buf) {
  const f = splitFields(buf);
  if (f.has(1)) return Buffer.from(f.get(1)[0]).toString('utf8'); // string_value
  if (f.has(2)) return f.get(2)[0] !== 0n; // bool_value
  if (f.has(3)) return Number(BigInt.asIntN(64, f.get(3)[0])); // int_value
  if (f.has(4)) return Buffer.from(f.get(4)[0]).readDoubleLE(0); // double_value
  return undefined; // array/kvlist/bytes values: not needed for our attributes
}

function decodeKeyValue(buf) {
  const f = splitFields(buf);
  const key = f.get(1)?.[0] ? Buffer.from(f.get(1)[0]).toString('utf8') : undefined;
  const valueBuf = f.get(2)?.[0];
  return { key, value: valueBuf ? decodeAnyValue(valueBuf) : undefined };
}

function decodeAttributeList(fields, fieldNumber) {
  const out = {};
  for (const raw of fields.get(fieldNumber) ?? []) {
    const { key, value } = decodeKeyValue(raw);
    if (key !== undefined) out[key] = value;
  }
  return out;
}

function decodeSpan(buf) {
  const f = splitFields(buf);
  return {
    traceId: toHex(f.get(1)?.[0]),
    spanId: toHex(f.get(2)?.[0]),
    parentSpanId: f.get(4)?.[0] ? toHex(f.get(4)[0]) : null,
    name: f.get(5)?.[0] ? Buffer.from(f.get(5)[0]).toString('utf8') : '',
    startTimeUnixNano: readFixed64LE(f.get(7)?.[0]),
    endTimeUnixNano: readFixed64LE(f.get(8)?.[0]),
    attributes: decodeAttributeList(f, 9),
  };
}

function decodeScopeSpans(buf) {
  const f = splitFields(buf);
  return (f.get(2) ?? []).map(decodeSpan);
}

function decodeResourceSpans(buf) {
  const f = splitFields(buf);
  const resourceAttributes = f.get(1)?.[0] ? decodeAttributeList(splitFields(f.get(1)[0]), 1) : {};
  const spans = (f.get(2) ?? []).flatMap(decodeScopeSpans);
  return { resourceAttributes, spans };
}

// Returns one { resourceAttributes, spans } group per ResourceSpans entry.
function decodeProtobuf(buf) {
  const f = splitFields(buf);
  return (f.get(1) ?? []).map(decodeResourceSpans);
}

// Same output shape as decodeProtobuf, from the proto3 JSON mapping instead
// of the wire format: trace/span IDs are plain hex (an OTLP-specific
// deviation from the generic mapping), 64-bit ints are decimal strings
// (already what we want for start/endTimeUnixNano).
function jsonAnyValue(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  return undefined;
}

function jsonAttributeList(attrs) {
  const out = {};
  for (const kv of attrs ?? []) {
    if (kv?.key === undefined) continue;
    out[kv.key] = jsonAnyValue(kv.value);
  }
  return out;
}

function decodeJson(text) {
  const parsed = JSON.parse(text);
  return (parsed.resourceSpans ?? []).map((rs) => ({
    resourceAttributes: jsonAttributeList(rs.resource?.attributes),
    // OTLP/JSON sends trace/span IDs as plain hex strings, not base64 --
    // this is a deliberate OTLP deviation from the generic proto3 JSON
    // mapping (which would base64-encode arbitrary `bytes` fields).
    spans: (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => ({
      traceId: s.traceId ?? '',
      spanId: s.spanId ?? '',
      parentSpanId: s.parentSpanId ?? null,
      name: s.name ?? '',
      startTimeUnixNano: s.startTimeUnixNano ?? '0',
      endTimeUnixNano: s.endTimeUnixNano ?? '0',
      attributes: jsonAttributeList(s.attributes),
    }))),
  }));
}

module.exports = { decodeProtobuf, decodeJson };
