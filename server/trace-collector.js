const history = require('./history');

function windowMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_TRACE_WINDOW_MS, 10);
  return Number.isFinite(parsed) ? parsed : 10_000;
}

// requestId -> { functionId, spans, closesAt }
const buffers = new Map();
const timers = new Map();

function open(requestId, functionId) {
  buffers.set(requestId, { functionId, spans: [], closesAt: null });
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
  buf.closesAt = Date.now() + windowMs();
  const timer = setTimeout(() => close(requestId), windowMs());
  timer.unref?.();
  timers.set(requestId, timer);
  return { spans };
}

function close(requestId) {
  const buf = buffers.get(requestId);
  buffers.delete(requestId);
  const timer = timers.get(requestId);
  if (timer) { clearTimeout(timer); timers.delete(requestId); }
  if (buf?.functionId) {
    try { history.appendSpans(buf.functionId, requestId, [], false); } catch {}
  }
}

module.exports = { open, ingest, snapshotAndStartWindow, close, windowMs };
