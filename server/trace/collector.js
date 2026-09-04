const history = require('../persistence/history');

function windowMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_TRACE_WINDOW_MS, 10);
  return Number.isFinite(parsed) ? parsed : 10_000;
}

// requestId -> { functionId, spans, closesAt }
const buffers = new Map();
const timers = new Map();
// instanceId -> requestId currently being served by that execution
// environment. A warm process sets its OTLP resource attributes once, at
// startup, so spans cannot carry a per-invoke id -- they carry the stable
// environment id instead and are resolved through here. Safe because the
// in-flight guard means an environment serves one invoke at a time.
const instanceRequests = new Map();

function open(requestId, functionId, instanceId) {
  buffers.set(requestId, { functionId, spans: [], closesAt: null, instanceId });
  if (instanceId) instanceRequests.set(instanceId, requestId);
}

function requestForInstance(instanceId) {
  return instanceRequests.get(instanceId) ?? null;
}

// Called whenever a span batch for this requestId arrives. If the invoke
// has already exited (closesAt set, i.e. invoke() already returned its
// initial snapshot), the newly-arrived spans are also persisted right
// away, since the web UI relies on polling to pick these up.
function ingest(requestId, spans) {
  const buf = buffers.get(requestId);
  if (!buf) return; // unknown or already-closed requestId: drop silently
  buf.spans.push(...spans);
  if (buf.closesAt !== null && buf.functionId) {
    try { history.appendSpans(buf.functionId, requestId, spans, true); } catch {}
  }
}

// Called right after the invoked child process exits. Returns the current
// snapshot for the invoke's initial response, and starts the countdown
// after which no more spans are accepted for this requestId.
function snapshotAndStartWindow(requestId) {
  const buf = buffers.get(requestId);
  if (!buf) return { spans: [] };
  const spans = buf.spans.slice();
  const ms = windowMs();
  buf.closesAt = Date.now() + ms;
  const timer = setTimeout(() => close(requestId), ms);
  timer.unref?.();
  timers.set(requestId, timer);
  return { spans };
}

// Non-mutating read of the live buffer, used by the read API to answer
// "is this invoke's trace still open" from memory instead of disk. Once
// close() removes the buffer, its absence IS the pending:false signal --
// no persisted flag is needed for that, which is what lets close() below
// skip writing to history entirely.
function peek(requestId) {
  return buffers.get(requestId) ?? null;
}

// No history write here: any spans that actually arrived were already
// persisted incrementally by ingest() above. The only thing this used to
// write was a pending:false flag -- now derived live from peek() instead,
// which is what removes a full read-parse-rewrite of the function's whole
// history file from every single invoke's tail end.
function close(requestId) {
  const buf = buffers.get(requestId);
  if (buf?.instanceId && instanceRequests.get(buf.instanceId) === requestId) {
    instanceRequests.delete(buf.instanceId);
  }
  buffers.delete(requestId);
  const timer = timers.get(requestId);
  if (timer) { clearTimeout(timer); timers.delete(requestId); }
}

module.exports = { open, ingest, snapshotAndStartWindow, peek, close, windowMs, requestForInstance };
