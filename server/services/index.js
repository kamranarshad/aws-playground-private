const { REGISTRY, names, labelFor, envFor, composeEnv } = require('./registry');
const { status, statusAll, waitReady } = require('./docker');
const { start, stop, setSelection, stopAutoStarted, graceMs } = require('./lifecycle');

async function list() {
  const states = await statusAll();
  const services = Object.entries(REGISTRY).map(([name, svc]) => ({
    name,
    label: svc.label,
    shortLabel: svc.shortLabel,
    note: svc.note ?? null,
    state: states ? states.get(name) : 'unavailable',
    endpoint: svc.endpoint,
    consoleUrl: svc.consoleUrl,
    credentials: svc.credentials ?? [],
  }));
  return { docker: { available: states !== null }, services };
}

module.exports = { status, statusAll, start, stop, list, envFor,
  composeEnv, names, labelFor, setSelection, stopAutoStarted, waitReady, graceMs };
