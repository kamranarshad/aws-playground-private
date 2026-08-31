const defaultLocalServices = require('../../services');
const {
  NOTIFICATION_ID, NOTIFICATION_ARN, categoryFor, normalizeRecord, dispatch,
} = require('./events');
const {
  buildClient, ensureBucket, syncBucketNotification, ensureBucketConfig,
} = require('./bucket-config');
const { createRequestHandler, createListener, PORT, HOST } = require('./listener');

// bucket -> Map<functionId, { events, prefix, suffix }>. Unlike http.js's
// shared listener (started/stopped by this module based on trigger state),
// the S3 webhook listener is process-lifetime and started directly from
// bin/cli.js — this module only owns the route table and per-function
// status, exposed via s3RoutesFor for that listener to read.
const s3Routes = new Map();
const s3Triggered = new Map(); // functionId -> bucket
const s3Status = new Map(); // functionId -> { state, lastError, lastPolledAt }

// Because that listener is started outside this module, a failed bind (the
// webhook port already taken — likely whenever a second playground instance is
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
