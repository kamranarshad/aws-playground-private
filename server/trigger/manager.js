const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');

// functionId -> { queueName, stop, status }
const running = new Map();

function status(functionId) {
  return running.get(functionId)?.status ?? { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  return out;
}

async function startFor(fn) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = { queueName: fn.trigger.queueName, stop: () => {}, status: st };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('elasticmq', { auto: false, waitReady: false });
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'ElasticMQ failed to start' });
      return;
    }
    const handle = sqs.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    record.stop = handle.stop;
  } catch (err) {
    Object.assign(st, { state: 'error', lastError: err.message });
  }
}

function stop(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

async function sync(fn) {
  const shouldRun = !!(fn.trigger && fn.trigger.enabled);
  const current = running.get(fn.id);
  if (!shouldRun) {
    if (current) stop(fn.id);
    return;
  }
  if (current && current.queueName === fn.trigger.queueName) return;
  if (current) stop(fn.id);
  await startFor(fn);
}

async function resumeAll() {
  for (const fn of store.list()) await sync(fn);
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { sync, stop, resumeAll, stopAll, status, statusAll };
