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

// Fire-and-forget by design: MinIO doesn't wait on Lambda's result (see
// server/trigger/http.js's request handler for the contrasting synchronous
// case), so a rejected invoke is swallowed rather than surfaced anywhere —
// there's no caller left to report it to.
function dispatch(raw, { routesFor, invokeFunction }) {
  const bucket = raw.s3?.bucket?.name;
  const key = raw.s3?.object?.key;
  const category = categoryFor(raw.eventName);
  if (!bucket || !key || !category) return;
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

module.exports = { categoryFor, normalizeRecord, dispatch };
