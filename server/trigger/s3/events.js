// Pure functions over MinIO's webhook payload: what kind of event it is,
// which routes it matches, and how its object key decodes. No state, no
// network, no SDK -- which is why they sit apart from the driver.
const NOTIFICATION_ID = 'PLAYGROUND';
const NOTIFICATION_ARN = `arn:minio:sqs::${NOTIFICATION_ID}:webhook`;

function categoryFor(eventName) {
  if (typeof eventName !== 'string') return null;
  if (eventName.startsWith('s3:ObjectCreated:')) return 'ObjectCreated';
  if (eventName.startsWith('s3:ObjectRemoved:')) return 'ObjectRemoved';
  return null;
}

// MinIO's webhook payload is structurally close to a real S3 event
// notification but tags itself as the sender — normalized here so a
// fixture written against a standard S3Event/Records shape needs no
// MinIO-specific branching.
function normalizeRecord(record) {
  return { ...record, eventSource: 'aws:s3' };
}

function matchesRoute(route, category, key) {
  if (!route.events.includes(category)) return false;
  if (route.prefix && !key.startsWith(route.prefix)) return false;
  if (route.suffix && !key.endsWith(route.suffix)) return false;
  return true;
}

// MinIO (like real S3) form-URL-encodes the object key inside the
// notification payload — e.g. a real key of "images/pic.png" arrives here
// as "images%2Fpic.png" — so a raw-key comparison against a plain prefix
// like "images/" would never match. That encoding also writes a literal
// space as "+" (and a literal "+" as "%2B"), so "+" is turned back into a
// space *before* percent-decoding — otherwise a key of "my file.txt"
// arrives as "my+file.txt" and a prefix filter of "my " silently never
// matches. Decoded once here purely for our own routing/matching/display
// purposes; a malformed percent-sequence falls back to the raw value rather
// than throwing, since createRequestHandler's caller only wraps dispatch()
// as a whole, not this specific step.
function decodeKey(rawKey) {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, '%20'));
  } catch {
    return rawKey;
  }
}

// Fire-and-forget by design: MinIO doesn't wait on Lambda's result (see
// server/trigger/http.js's request handler for the contrasting synchronous
// case), so a rejected invoke is swallowed rather than surfaced anywhere —
// there's no caller left to report it to.
function dispatch(raw, { routesFor, invokeFunction }) {
  const bucket = raw.s3?.bucket?.name;
  const rawKey = raw.s3?.object?.key;
  const key = typeof rawKey === 'string' ? decodeKey(rawKey) : rawKey;
  const category = categoryFor(raw.eventName);
  if (!bucket || !key || !category) return;
  // The Records payload handed to the invoked function keeps the raw
  // (still percent-encoded) key from MinIO/S3 untouched — matching real
  // AWS, where a real S3-triggered Lambda receives event.Records[].s3.object.key
  // percent-encoded and is expected to decode it itself. Only the decoded
  // `key` above (used for route matching and the `source` field below,
  // which the trigger status/history UI reads) is normalized.
  const record = normalizeRecord(raw);
  for (const route of routesFor(bucket)) {
    if (!matchesRoute(route, category, key)) continue;
    invokeFunction({
      functionId: route.functionId,
      event: { Records: [record] },
      source: { type: 'trigger', bucket, key, eventName: raw.eventName },
    }).catch(() => {});
  }
}

module.exports = {
  NOTIFICATION_ID, NOTIFICATION_ARN, categoryFor, normalizeRecord, matchesRoute,
  decodeKey, dispatch,
};
