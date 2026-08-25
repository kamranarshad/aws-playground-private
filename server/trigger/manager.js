const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');
const httpTrigger = require('./http');
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

function status(functionId) {
  if (running.has(functionId)) return running.get(functionId).status;
  if (httpTriggered.has(functionId)) return httpStatus;
  return { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  for (const id of httpTriggered.keys()) out[id] = httpStatus;
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

function stop(functionId) {
  stopSqs(functionId);
  stopHttp(functionId);
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
}

async function resumeAll() {
  for (const fn of store.list()) await sync(fn);
}

function stopAll() {
  for (const id of running.keys()) stopSqs(id);
  for (const id of httpTriggered.keys()) stopHttp(id);
}

module.exports = { sync, stop, resumeAll, stopAll, status, statusAll };
