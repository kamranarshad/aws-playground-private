const store = require('../persistence/store');
const schema = require('../schema');
const { detectProject } = require('../runtime/detect');
const history = require('../persistence/history');
const inFlight = require('./in-flight');
const manager = require('../trigger/manager');
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
