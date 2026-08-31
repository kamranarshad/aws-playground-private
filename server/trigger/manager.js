const store = require('../persistence/store');
const sqs = require('./sqs');
const dynamodbTrigger = require('./dynamodb');
const httpTrigger = require('./http');
const s3Trigger = require('./s3');
const { effectiveTrigger } = require('./effective');

// Every driver owns its own state (private to its module) and exposes the
// same four-method shape. Adding a fifth trigger type means writing one new
// driver module and adding it to this list — nothing else in this file
// changes.
const DRIVERS = [sqs, dynamodbTrigger, httpTrigger, s3Trigger];

function stop(functionId) {
  for (const d of DRIVERS) d.stop(functionId);
}

async function sync(fn, deps = {}) {
  const trigger = effectiveTrigger(fn);
  // Clean up any stale registration under the *other* trigger type(s) first —
  // covers switching sqs <-> http <-> dynamodb <-> s3 on the same function.
  for (const d of DRIVERS) if (d.type !== trigger?.type) d.stop(fn.id);
  const driver = DRIVERS.find((d) => d.type === trigger?.type);
  if (driver) await driver.sync(fn, trigger, deps);
}

async function resumeAll(deps = {}) {
  for (const fn of store.list()) await sync(fn, deps);
}

function stopAll() {
  for (const id of Object.keys(statusAll())) stop(id);
}

function status(functionId) {
  for (const d of DRIVERS) {
    const st = d.status(functionId);
    if (st) return st;
  }
  return { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const d of DRIVERS) Object.assign(out, d.statusAll());
  return out;
}

module.exports = {
  sync, stop, resumeAll, stopAll, status, statusAll,
  s3RoutesFor: s3Trigger.s3RoutesFor,
  setS3ListenerError: s3Trigger.setS3ListenerError,
  drainBucketConfigQueue: s3Trigger.drainBucketConfigQueue,
};
