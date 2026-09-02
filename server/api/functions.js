const store = require('../persistence/store');
const schema = require('../schema');
const { detectProject } = require('../runtime/detect');
const history = require('../persistence/history');
const inFlight = require('./in-flight');
const manager = require('../trigger/manager');
const pool = require('../runtime/pool');
const { invokeFunction } = require('./invoke');

const RUNTIMES = schema.RUNTIMES;

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

// Binds the store accessors once so createFunction/updateFunction read the
// same as before; the rules themselves live in server/schema.
function fieldError(fields, currentId = null) {
  return schema.validateFields(fields, { currentId, list: store.list, get: store.get });
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
  // The key would usually change anyway, but not for fields it excludes --
  // an edited function must never keep serving from the old configuration.
  pool.evictForFunction(id);
  manager.sync(fn, { invokeFunction });
  return { status: 200, body: fn };
}

function deleteFunction(id) {
  if (inFlight.has(id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  manager.stop(id);
  // A deleted function must not leave a handler process running.
  pool.evictForFunction(id);
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}

function detect(input) {
  const dir = (input || {}).path;
  if (!dir) return { status: 400, body: { error: 'path is required' } };
  return { status: 200, body: detectProject(dir) };
}

function getFunctionStats(id) {
  if (!store.get(id)) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: history.getStats(id) };
}

module.exports = { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect, getFunctionStats };
