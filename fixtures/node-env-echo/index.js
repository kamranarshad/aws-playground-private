// Echoes back whichever env vars the event asks for, so tests can assert on
// what the invoker does and does not pass through from the host.
exports.handler = async (event) => {
  const keys = Array.isArray(event?.keys) ? event.keys : [];
  return Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
};
