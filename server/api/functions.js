const fs = require('fs');
const store = require('../store');
const { detectProject } = require('../detect');
const history = require('../history');
const inFlight = require('./in-flight');
const manager = require('../trigger/manager');
const { invokeFunction } = require('./invoke');

const RUNTIMES = ['python', 'node', 'java', 'provided'];

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

function triggerError(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (trigger.type !== 'sqs' && trigger.type !== 'http' && trigger.type !== 'dynamodb' && trigger.type !== 's3') {
    return `unsupported trigger type '${trigger.type}'`;
  }
  if (trigger.type === 'sqs' && (typeof trigger.queueName !== 'string' || !trigger.queueName.trim())) {
    return 'trigger.queueName is required';
  }
  if (trigger.type === 'dynamodb' && (typeof trigger.tableName !== 'string' || !trigger.tableName.trim())) {
    return 'trigger.tableName is required';
  }
  if (trigger.type === 's3') {
    if (typeof trigger.bucket !== 'string' || !trigger.bucket.trim()) return 'trigger.bucket is required';
    if (!Array.isArray(trigger.events) || trigger.events.length === 0
      || !trigger.events.every((e) => e === 'ObjectCreated' || e === 'ObjectRemoved')) {
      return "trigger.events must be a non-empty array of 'ObjectCreated'/'ObjectRemoved'";
    }
    // Normalized in place (this object is the one that goes on to the store):
    // a repeated event means nothing extra, and a stored duplicate would make
    // a real events-list change look unchanged to the trigger manager's
    // route comparison, silently skipping the reconfigure.
    trigger.events = [...new Set(trigger.events)];
    if (trigger.prefix !== undefined && typeof trigger.prefix !== 'string') return 'trigger.prefix must be a string';
    if (trigger.suffix !== undefined && typeof trigger.suffix !== 'string') return 'trigger.suffix must be a string';
  }
  if (typeof trigger.enabled !== 'boolean') return 'trigger.enabled must be a boolean';
  return null;
}

// Shared between create (fields always present) and update (fields present
// only when patched) so a PATCH can't put the store into a state POST would
// have rejected — e.g. a non-numeric timeoutMs, which downstream clamps
// setTimeout to ~1ms and SIGKILLs every future invoke almost instantly.
// `currentId` is the function's own id on update (excluded from the name
// collision checks below); null on create, where there's no "self" yet.
function fieldError(fields, currentId = null) {
  if ('runtime' in fields && !RUNTIMES.includes(fields.runtime)) {
    return `unsupported runtime '${fields.runtime}'`;
  }
  if ('path' in fields
    && (!fs.existsSync(fields.path) || !fs.statSync(fields.path).isDirectory())) {
    return `path is not a directory: ${fields.path}`;
  }
  if ('timeoutMs' in fields && !(Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0)) {
    return 'timeoutMs must be a positive number';
  }
  if ('memoryMb' in fields && !(Number.isFinite(fields.memoryMb) && fields.memoryMb > 0)) {
    return 'memoryMb must be a positive number';
  }
  if ('autoTrace' in fields && typeof fields.autoTrace !== 'boolean') {
    return 'autoTrace must be a boolean';
  }
  // Required for the HTTP trigger's routing-by-name to be unambiguous, but
  // enforced unconditionally (not just when a trigger is involved) — the
  // simpler, single rule to reason about.
  if ('name' in fields
    && typeof fields.name === 'string'
    && store.list().some((f) => f.name === fields.name && f.id !== currentId)) {
    return `a function named '${fields.name}' already exists`;
  }
  if ('trigger' in fields) {
    const triggerErr = triggerError(fields.trigger);
    if (triggerErr) return triggerErr;
  }
  // The effective trigger is whatever this patch leaves in place: the new
  // trigger if it's being changed here, otherwise the function's current
  // stored trigger. A name-only rename (no `trigger` in this patch) must
  // still be checked against an already-enabled http trigger, since it can
  // just as easily break routing.
  const effectiveTrigger = 'trigger' in fields ? fields.trigger : (currentId ? store.get(currentId)?.trigger : null);
  if (effectiveTrigger?.type === 'http' && effectiveTrigger.enabled) {
    // The effective name is whatever this patch leaves in place: the new
    // name if it's being changed here, otherwise the function's current
    // stored name.
    const name = 'name' in fields ? fields.name : (currentId ? store.get(currentId)?.name : undefined);
    if (typeof name === 'string' && name.includes('/')) {
      return "an HTTP trigger requires a name without '/' characters";
    }
    if (typeof name === 'string'
      && store.list().some((f) => f.name === name && f.id !== currentId)) {
      return `a function named '${name}' already exists — rename it before enabling an HTTP trigger`;
    }
  }
  return null;
}

function createFunction(input) {
  const { name, path: dir, runtime } = input || {};
  if (!name || !dir || !runtime) {
    return { status: 400, body: { error: 'name, path and runtime are required' } };
  }
  const err = fieldError(input);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.create(input);
  manager.sync(fn, { invokeFunction });
  return { status: 201, body: fn };
}

function updateFunction(id, patch) {
  const p = patch || {};
  const err = fieldError(p, id);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.update(id, p);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  manager.sync(fn, { invokeFunction });
  return { status: 200, body: fn };
}

function deleteFunction(id) {
  if (inFlight.has(id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  manager.stop(id);
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}

function detect(input) {
  const dir = (input || {}).path;
  if (!dir) return { status: 400, body: { error: 'path is required' } };
  return { status: 200, body: detectProject(dir) };
}

module.exports = { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect };
