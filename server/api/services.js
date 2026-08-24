const store = require('../store');
const projectconfig = require('../projectconfig');
const localServices = require('../services');

function effectiveServices(fn) {
  return projectconfig.read(fn.path).services ?? fn.localServices ?? [];
}

// fn.localServices (and playground.json's services list) are never validated
// against the service registry when they're written, so a stale/typo'd name
// can reach localServices' internals, which throw for anything unregistered.
// Catch that here with the same clean 400 the rest of the API gives instead
// of letting it surface as an unhandled rejection / opaque 500.
function unknownServiceError(names) {
  const known = localServices.names();
  const unknown = names.find(name => !known.includes(name));
  return unknown ? `unknown service '${unknown}' configured for this function` : null;
}

async function listServices() {
  return { status: 200, body: await localServices.list() };
}

async function startService(name, opts) {
  if (!localServices.names().includes(name)) {
    return { status: 404, body: { error: `unknown service '${name}'` } };
  }
  const r = await localServices.start(name, opts);
  if (!r.ok) return { status: 409, body: { error: r.output, state: r.state } };
  return { status: 200, body: { state: r.state } };
}

async function stopService(name) {
  if (!localServices.names().includes(name)) {
    return { status: 404, body: { error: `unknown service '${name}'` } };
  }
  const r = await localServices.stop(name);
  if (!r.ok) return { status: 409, body: { error: r.output, state: r.state } };
  return { status: 200, body: { state: r.state } };
}

function selectionOpts(input) {
  // waitReady:false is a test affordance; the UI never sends it.
  return input?.waitReady === false ? { waitReady: false } : {};
}

async function setSelection(input) {
  const { functionId } = input || {};
  if (functionId === null || functionId === undefined) {
    return { status: 200,
      body: await localServices.setSelection([], selectionOpts(input)) };
  }
  const fn = store.get(functionId);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  const services = effectiveServices(fn);
  const err = unknownServiceError(services);
  if (err) return { status: 400, body: { error: err } };
  return { status: 200,
    body: await localServices.setSelection(services, selectionOpts(input)) };
}

module.exports = { effectiveServices, unknownServiceError,
  listServices, startService, stopService, setSelection };
