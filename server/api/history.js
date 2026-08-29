const store = require('../store');
const history = require('../history');

function listHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: { entries: history.list(functionId) } };
}

function clearHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  history.clear(functionId);
  return { status: 204 };
}

function getInvokeTrace(functionId, requestId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  const entry = history.getByRequestId(functionId, requestId);
  if (!entry) return { status: 404, body: { error: 'invoke not found' } };
  return { status: 200, body: { trace: entry.trace ?? null } };
}

module.exports = { listHistory, clearHistory, getInvokeTrace };
