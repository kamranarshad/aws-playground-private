const http = require('http');
const { S3Client, CreateBucketCommand, PutBucketNotificationConfigurationCommand } = require('@aws-sdk/client-s3');
const { awsClientOptions } = require('../services/registry');
const defaultLocalServices = require('../services');

const PORT = 9501;
const HOST = '127.0.0.1';

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

function buildClient() {
  return new S3Client({ ...awsClientOptions('minio'), region: 'us-east-1', forcePathStyle: true });
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  }
}

async function syncBucketNotification(client, bucket, hasWatchers) {
  await client.send(new PutBucketNotificationConfigurationCommand({
    Bucket: bucket,
    NotificationConfiguration: {
      QueueConfigurations: hasWatchers ? [{
        Id: NOTIFICATION_ID,
        QueueArn: NOTIFICATION_ARN,
        Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
      }] : [],
    },
  }));
}

// The single entry point the trigger manager calls: creates the bucket (only
// worth doing when something is about to watch it) and always brings its
// notification config in line with whether anything watches it now.
async function ensureBucketConfig(bucket, hasWatchers) {
  const client = buildClient();
  if (hasWatchers) await ensureBucket(client, bucket);
  await syncBucketNotification(client, bucket, hasWatchers);
}

function createRequestHandler({ routesFor, invokeFunction }) {
  return async function handleRequest(req, res) {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Always 200 once the body is read — MinIO doesn't wait on the actual
    // invoke outcome (see dispatch's fire-and-forget invokeFunction call),
    // and a malformed body is our problem to log, not MinIO's to retry.
    res.writeHead(200);
    res.end();
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return;
    }
    const records = Array.isArray(payload.Records) ? payload.Records : [];
    for (const record of records) {
      try {
        dispatch(record, { routesFor, invokeFunction });
      } catch {
        // Silently drop records that cause dispatch to fail — this fire-and-forget
        // listener must never crash the process or reject a request.
      }
    }
  };
}

// Stateless factory — one shared instance is started once from bin/cli.js
// for the life of the process (unlike server/trigger/http.js's listener,
// which the trigger manager starts/stops based on trigger state), so it
// needs no singleton bookkeeping here.
function createListener({ routesFor, invokeFunction, port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler({ routesFor, invokeFunction }));
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      // An 'error' emitted after a successful bind (e.g. an accept-queue
      // error) has no listener left to catch it, and an unhandled 'error' on
      // an EventEmitter takes the whole process down. Log it instead — same
      // shape as server/trigger/http.js's post-bind onError re-attachment.
      server.on('error', (err) => {
        console.warn(`aws-playground: S3 webhook listener error: ${err.message}`);
      });
      resolve({ server, stop: () => server.close() });
    });
  });
}

// bucket -> Map<functionId, { events, prefix, suffix }>. Unlike http.js's
// shared listener (started/stopped by this module based on trigger state),
// the S3 webhook listener is process-lifetime and started directly from
// bin/cli.js — this module only owns the route table and per-function
// status, exposed via s3RoutesFor for that listener to read.
const s3Routes = new Map();
const s3Triggered = new Map(); // functionId -> bucket
const s3Status = new Map(); // functionId -> { state, lastError, lastPolledAt }

// Because that listener is started outside this module, a failed bind (port
// 9501 already taken — likely whenever a second playground instance is
// running, which bin/cli.js's port scan explicitly supports) would otherwise
// be invisible here and every S3 trigger would keep reporting 'listening'
// while nothing can ever reach it. bin/cli.js reports the failure in through
// setS3ListenerError so the status the UI shows says 'error' instead.
let s3ListenerError = null; // error message | null

function setS3ListenerError(err) {
  s3ListenerError = err ? (err.message || String(err)) : null;
}

function s3RoutesFor(bucket) {
  const m = s3Routes.get(bucket);
  return m ? [...m].map(([functionId, r]) => ({ functionId, ...r })) : [];
}

// ensureBucketConfig hits a real network call (PutBucketNotificationConfigurationCommand)
// with no ordering guarantee between concurrent calls. A fast disable-then-re-enable
// (or two functions racing on the same bucket) could otherwise complete out of order
// and leave the bucket's live notification config not matching the current route table.
// Chaining every call for a given bucket onto the same promise makes calls for that
// bucket strictly sequential, in the order they were issued.
const bucketConfigQueue = new Map(); // bucket -> Promise (tail of the pending chain)

function queueBucketConfig(bucket, hasWatchers) {
  const prev = bucketConfigQueue.get(bucket) ?? Promise.resolve();
  const next = prev.then(() => module.exports.ensureBucketConfig(bucket, hasWatchers));
  bucketConfigQueue.set(bucket, next.catch(() => {})); // keep the chain alive past a rejection
  return next;
}

// Test-only. The disable path queues its ensureBucketConfig call and returns
// immediately, so the actual call lands a microtask later — a test that stubs
// ensureBucketConfig and restores it in a `finally` would otherwise restore
// the real (network-calling) implementation before the stub was ever reached.
// Awaiting this settles every currently-queued bucket-config call first.
function drainBucketConfigQueue() {
  return Promise.all(bucketConfigQueue.values());
}

// A dead shared listener outranks whatever the per-function sync recorded:
// the bucket may well be configured correctly, but no event can reach us.
function s3StatusFor(functionId) {
  if (s3ListenerError) return { state: 'error', lastError: s3ListenerError, lastPolledAt: null };
  return s3Status.get(functionId);
}

function status(functionId) {
  return s3Status.has(functionId) ? s3StatusFor(functionId) : undefined;
}

function statusAll() {
  const out = {};
  for (const id of s3Status.keys()) out[id] = s3StatusFor(id);
  return out;
}

// Compared as sets, not as arrays: a stored `events` with a duplicate in it
// (['ObjectCreated', 'ObjectCreated']) has the same length as a genuinely
// different two-event list, and a plain length + includes() check would call
// those equal and silently skip the reconfigure. Both validators dedupe now,
// so this is belt-and-braces for data written before they did.
function routeEquals(a, b) {
  if (!a || a.prefix !== b.prefix || a.suffix !== b.suffix) return false;
  const aEvents = new Set(a.events);
  const bEvents = new Set(b.events);
  return aEvents.size === bEvents.size && [...aEvents].every((e) => bEvents.has(e));
}

function removeS3Route(functionId, bucket) {
  const bucketRoutes = s3Routes.get(bucket);
  if (bucketRoutes) {
    bucketRoutes.delete(functionId);
    if (bucketRoutes.size === 0) {
      s3Routes.delete(bucket);
      // Fire-and-forget from the caller's point of view (stop() is sync), but
      // not silent: a bucket left with a live webhook config pointing at a
      // listener nothing routes to is worth a line in the server log — the
      // enable path has a visible error status to surface this, the disable
      // path has nowhere else to put it.
      queueBucketConfig(bucket, false).catch((err) => {
        console.warn(`aws-playground: failed to clear S3 notification config for bucket '${bucket}': ${err.message}`);
      });
    }
  }
  s3Triggered.delete(functionId);
  s3Status.delete(functionId);
}

function stop(functionId) {
  const bucket = s3Triggered.get(functionId);
  if (bucket === undefined) return;
  removeS3Route(functionId, bucket);
}

// Idempotent: a no-op re-sync of an already-configured, unchanged,
// non-error route is safe to call as often as the caller likes.
async function sync(fn, trigger, deps = {}) {
  const localServices = deps.localServices ?? defaultLocalServices;
  if (!trigger.enabled) { stop(fn.id); return; }

  const functionId = fn.id;
  const previousBucket = s3Triggered.get(functionId);
  const previousRoute = previousBucket ? s3Routes.get(previousBucket)?.get(functionId) : undefined;
  const st = s3Status.get(functionId);
  if (previousBucket === trigger.bucket && routeEquals(previousRoute, trigger) && st?.state !== 'error') return;
  if (previousBucket !== undefined && previousBucket !== trigger.bucket) removeS3Route(functionId, previousBucket);

  let bucketRoutes = s3Routes.get(trigger.bucket);
  if (!bucketRoutes) { bucketRoutes = new Map(); s3Routes.set(trigger.bucket, bucketRoutes); }
  bucketRoutes.set(functionId, { events: trigger.events, prefix: trigger.prefix, suffix: trigger.suffix });
  s3Triggered.set(functionId, trigger.bucket);
  s3Status.set(functionId, { state: 'listening', lastError: null, lastPolledAt: null });

  try {
    const started = await localServices.start('minio', { auto: false });
    // Stopped, deleted, or reconfigured to a different bucket while MinIO
    // was starting — the route table no longer reflects what we started
    // for, so leave it alone rather than resurrect a stale registration.
    if (s3Triggered.get(functionId) !== trigger.bucket) return;
    if (!started.ok) {
      s3Status.set(functionId, { state: 'error', lastError: started.output || 'MinIO failed to start', lastPolledAt: null });
      return;
    }
    await queueBucketConfig(trigger.bucket, true);
    if (s3Triggered.get(functionId) !== trigger.bucket) return;
    s3Status.set(functionId, { state: 'listening', lastError: null, lastPolledAt: null });
  } catch (err) {
    if (s3Triggered.get(functionId) === trigger.bucket) {
      s3Status.set(functionId, { state: 'error', lastError: err.message, lastPolledAt: null });
    }
  }
}

module.exports = {
  type: 's3',
  sync, stop, status, statusAll,
  s3RoutesFor, setS3ListenerError, drainBucketConfigQueue,
  categoryFor, normalizeRecord, dispatch,
  buildClient, ensureBucket, syncBucketNotification, ensureBucketConfig,
  NOTIFICATION_ID, NOTIFICATION_ARN,
  PORT, HOST, createRequestHandler, createListener,
};
