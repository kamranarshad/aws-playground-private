const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');
const httpTrigger = require('./http');
const s3Trigger = require('./s3');
const { effectiveTrigger } = require('./effective');

// functionId -> { queueName, stop, status }  (one SQS poller per function)
const running = new Map();

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

function s3RoutesFor(bucket) {
  const m = s3Routes.get(bucket);
  return m ? [...m.values()] : [];
}

function status(functionId) {
  if (running.has(functionId)) return running.get(functionId).status;
  if (httpTriggered.has(functionId)) return httpStatus;
  if (s3Status.has(functionId)) return s3Status.get(functionId);
  return { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  for (const id of httpTriggered.keys()) out[id] = httpStatus;
  for (const [id, st] of s3Status) out[id] = st;
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

function routeEquals(a, b) {
  return !!a && a.prefix === b.prefix && a.suffix === b.suffix
    && a.events.length === b.events.length && a.events.every((e) => b.events.includes(e));
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
    await s3Trigger.ensureBucketConfig(trigger.bucket, true);
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
      s3Trigger.ensureBucketConfig(bucket, false).catch(() => {});
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
  // Clean up any stale registration under the *other* trigger type first —
  // covers switching sqs <-> http on the same function.
  if (trigger?.type !== 'http' && httpTriggered.has(fn.id)) stopHttp(fn.id);
  if (trigger?.type !== 'sqs' && running.has(fn.id)) stopSqs(fn.id);
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
  for (const id of httpTriggered.keys()) stopHttp(id);
  for (const id of s3Triggered.keys()) stopS3(id);
}

module.exports = { sync, stop, resumeAll, stopAll, status, statusAll, s3RoutesFor };
