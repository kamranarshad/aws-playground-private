const store = require('../persistence/store');
const history = require('../persistence/history');
const traceCollector = require('../trace/collector');

function listHistory(functionId, opts = {}) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: { entries: history.list(functionId, opts) } };
}

function clearHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  history.clear(functionId);
  return { status: 204 };
}

// Prefers the live in-memory buffer over the persisted entry -- it's both
// cheaper (no disk read while a trace is still open, which is the only
// time a client is actually polling this) and more accurate: once the
// collector no longer holds the buffer, no more spans can possibly arrive,
// so pending is definitionally false at that point, regardless of whatever
// value happens to be sitting in the persisted record.
function getInvokeTrace(functionId, requestId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  const live = traceCollector.peek(requestId);
  if (live) return { status: 200, body: { trace: { spans: live.spans, pending: true } } };
  const entry = history.getByRequestId(functionId, requestId);
  if (!entry) return { status: 404, body: { error: 'invoke not found' } };
  const trace = entry.trace && typeof entry.trace === 'object'
    ? { spans: Array.isArray(entry.trace.spans) ? entry.trace.spans : [], pending: false }
    : null;
  return { status: 200, body: { trace } };
}

module.exports = { listHistory, clearHistory, getInvokeTrace };
