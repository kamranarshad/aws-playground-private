const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');
const httpTrigger = require('./http');
const dynamodbTrigger = require('./dynamodb');
const s3Trigger = require('./s3');
const { effectiveTrigger } = require('./effective');

// functionId -> { queueName, stop, status }  (one SQS poller per function)
const running = new Map();

// functionId -> { tableName, stop, status }  (one DynamoDB Streams poller
// per function, same one-poller-per-function shape as SQS above)
const runningDynamo = new Map();

// The HTTP trigger is one shared listener across every function that enables
// it, not one per function like SQS — httpRoutes is read live by the
// listener on every request, so toggling/renaming a trigger never needs to
// restart it. httpTriggered tracks each function's currently-registered name
// so a rename or disable knows which route entry to remove.
const httpRoutes = new Map(); // name -> functionId
const httpTriggered = new Map(); // functionId -> name
let httpListener = null; // { server, stop } | null
let httpListenerStarting = null; // in-flight start Promise, deduplicates concurrent enables
let httpStatus = { state: 'idle', lastError: null, lastPolledAt: null };

// bucket -> Map<functionId, { events, prefix, suffix }>. Unlike the HTTP
// trigger's shared listener (started/stopped by this manager based on
// trigger state), the S3 webhook listener is process-lifetime and started
// directly from bin/cli.js — this manager only owns the route table and
// per-function status, exposed via s3RoutesFor for that listener to read.
const s3Routes = new Map();
const s3Triggered = new Map(); // functionId -> bucket
const s3Status = new Map(); // functionId -> { state, lastError, lastPolledAt }

// Because that listener is started outside this manager, a failed bind (port
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
  const next = prev.then(() => s3Trigger.ensureBucketConfig(bucket, hasWatchers));
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
  if (running.has(functionId)) return running.get(functionId).status;
  if (runningDynamo.has(functionId)) return runningDynamo.get(functionId).status;
  if (httpTriggered.has(functionId)) return httpStatus;
  if (s3Status.has(functionId)) return s3StatusFor(functionId);
  return { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  for (const [id, r] of runningDynamo) out[id] = r.status;
  for (const id of httpTriggered.keys()) out[id] = httpStatus;
  for (const id of s3Status.keys()) out[id] = s3StatusFor(id);
  return out;
}

async function startFor(fn) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = {
    queueName: fn.trigger.queueName,
    status: st,
    cancelled: false,
    stop: () => { record.cancelled = true; },
  };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('elasticmq', { auto: false });
    if (record.cancelled) return;
    if (!store.get(fn.id)) {
      // Function was deleted while ElasticMQ was starting up; deleteFunction's
      // manager.stop(id) was a no-op since nothing was in `running` yet. Clean
      // up instead of starting a poller for a function that no longer exists.
      running.delete(fn.id);
      return;
    }
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'ElasticMQ failed to start' });
      return;
    }
    const handle = sqs.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    if (record.cancelled) {
      handle.stop();
      return;
    }
    record.stop = handle.stop;
  } catch (err) {
    if (!record.cancelled) Object.assign(st, { state: 'error', lastError: err.message });
  }
}

function stopSqs(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

async function startForDynamo(fn) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = {
    tableName: fn.trigger.tableName,
    status: st,
    cancelled: false,
    stop: () => { record.cancelled = true; },
  };
  runningDynamo.set(fn.id, record);
  try {
    const started = await localServices.start('dynamodb', { auto: false });
    if (record.cancelled) return;
    if (!store.get(fn.id)) {
      runningDynamo.delete(fn.id);
      return;
    }
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'DynamoDB Local failed to start' });
      return;
    }
    const handle = dynamodbTrigger.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    if (record.cancelled) {
      handle.stop();
      return;
    }
    record.stop = handle.stop;
  } catch (err) {
    if (!record.cancelled) Object.assign(st, { state: 'error', lastError: err.message });
  }
}

function stopDynamo(functionId) {
  const r = runningDynamo.get(functionId);
  if (!r) return;
  r.stop();
  runningDynamo.delete(functionId);
}

function stopHttpListenerIfIdle() {
  if (httpRoutes.size === 0 && httpListener) {
    httpListener.stop();
    httpListener = null;
    httpStatus = { state: 'idle', lastError: null, lastPolledAt: null };
  }
}

function stopHttp(functionId) {
  const name = httpTriggered.get(functionId);
  if (name === undefined) return;
  httpRoutes.delete(name);
  httpTriggered.delete(functionId);
  stopHttpListenerIfIdle();
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

async function syncS3(functionId, trigger) {
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

function stopS3(functionId) {
  const bucket = s3Triggered.get(functionId);
  if (bucket === undefined) return;
  removeS3Route(functionId, bucket);
}

function stop(functionId) {
  stopSqs(functionId);
  stopDynamo(functionId);
  stopHttp(functionId);
  stopS3(functionId);
}

async function ensureHttpListenerRunning() {
  if (httpListener) return;
  if (httpListenerStarting) return httpListenerStarting;
  httpListenerStarting = (async () => {
    try {
      httpListener = await httpTrigger.createListener({
        resolveFunctionId: (name) => httpRoutes.get(name) ?? null,
        invokeFunction: require('../api/invoke').invokeFunction,
        onError: (err) => { httpStatus = { state: 'error', lastError: err.message, lastPolledAt: null }; },
      });
      if (httpRoutes.size === 0) {
        // Every function that wanted this listener disabled/deleted its
        // trigger while the real socket bind was still in flight — the
        // listener is orphaned the moment it comes up. Tear it down instead
        // of leaving a live listener with nothing routed to it.
        httpListener.stop();
        httpListener = null;
        httpStatus = { state: 'idle', lastError: null, lastPolledAt: null };
      } else {
        httpStatus = { state: 'listening', lastError: null, lastPolledAt: null };
      }
    } catch (err) {
      httpStatus = { state: 'error', lastError: err.message, lastPolledAt: null };
    } finally {
      httpListenerStarting = null;
    }
  })();
  return httpListenerStarting;
}

async function syncHttp(fn) {
  const current = httpTriggered.get(fn.id);
  if (current !== undefined && current !== fn.name) httpRoutes.delete(current);
  httpRoutes.set(fn.name, fn.id);
  httpTriggered.set(fn.id, fn.name);
  await ensureHttpListenerRunning();
}

async function sync(fn) {
  const trigger = effectiveTrigger(fn);
  // Clean up any stale registration under the *other* trigger type(s) first —
  // covers switching sqs <-> http <-> dynamodb <-> s3 on the same function.
  if (trigger?.type !== 'http' && httpTriggered.has(fn.id)) stopHttp(fn.id);
  if (trigger?.type !== 'sqs' && running.has(fn.id)) stopSqs(fn.id);
  if (trigger?.type !== 'dynamodb' && runningDynamo.has(fn.id)) stopDynamo(fn.id);
  if (trigger?.type !== 's3' && s3Triggered.has(fn.id)) stopS3(fn.id);

  if (trigger?.type === 'sqs') {
    const shouldRun = !!trigger.enabled;
    const current = running.get(fn.id);
    if (!shouldRun) {
      if (current) stopSqs(fn.id);
      return;
    }
    if (current && current.queueName === trigger.queueName && current.status.state !== 'error') return;
    if (current) stopSqs(fn.id);
    // startFor (and everything it calls) reads fn.trigger.queueName directly
    // off the object it's given — pass the resolved effective trigger
    // through fn so a playground.json-only sqs trigger (where fn.trigger
    // itself may be null or different) still reaches the right queue.
    await startFor({ ...fn, trigger });
    return;
  }

  if (trigger?.type === 'dynamodb') {
    const shouldRun = !!trigger.enabled;
    const current = runningDynamo.get(fn.id);
    if (!shouldRun) {
      if (current) stopDynamo(fn.id);
      return;
    }
    if (current && current.tableName === trigger.tableName && current.status.state !== 'error') return;
    if (current) stopDynamo(fn.id);
    // Same reasoning as the sqs branch above: pass the resolved effective
    // trigger through fn so startForDynamo reads the right table name
    // whether it came from playground.json or the manually-stored trigger.
    await startForDynamo({ ...fn, trigger });
    return;
  }

  if (trigger?.type === 'http') {
    // A '/' in the name can never be routed (the listener splits on the
    // first path segment) — the API refuses to let a *manual* trigger be
    // enabled against such a name, but a playground.json trigger bypasses
    // that check entirely. Treat it as inert rather than corrupt the
    // shared route table.
    if (!trigger.enabled || fn.name.includes('/')) { stopHttp(fn.id); return; }
    await syncHttp(fn);
  }

  if (trigger?.type === 's3') {
    if (!trigger.enabled) { stopS3(fn.id); return; }
    await syncS3(fn.id, trigger);
  }
}

async function resumeAll() {
  for (const fn of store.list()) await sync(fn);
}

function stopAll() {
  for (const id of running.keys()) stopSqs(id);
  for (const id of runningDynamo.keys()) stopDynamo(id);
  for (const id of httpTriggered.keys()) stopHttp(id);
  for (const id of s3Triggered.keys()) stopS3(id);
}

module.exports = {
  sync, stop, resumeAll, stopAll, status, statusAll, s3RoutesFor, setS3ListenerError,
  drainBucketConfigQueue,
};
