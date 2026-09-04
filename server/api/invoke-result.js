const crypto = require('crypto');

// The failure envelope invokeFunction returns for anything that stops a run
// before (or instead of) the handler executing: a service that isn't up, a
// build that failed. Built in one place because three hand-written copies
// are three chances for the shapes to drift apart.
function failureResult({ phase, type, message, memoryMb, logs = '', report = {} }) {
  return {
    ok: false,
    phase,
    error: { type, message, stackTrace: [] },
    logs,
    report: {
      requestId: crypto.randomUUID(),
      durationMs: 0,
      billedMs: 0,
      memoryMb,
      timedOut: false,
      ...report,
    },
  };
}

module.exports = { failureResult };
