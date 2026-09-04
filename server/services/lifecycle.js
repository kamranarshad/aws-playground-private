const { entry } = require('./registry');
const { docker, status, statusAll, waitReady } = require('./docker');

// knownState lets a caller that just probed docker (setSelection) skip a
// second probe for the same container. Omit it and start() checks itself.
/**
 * @param {string} name
 * @param {{ waitReady?: boolean, auto?: boolean, knownState?: string }} [opts]
 */
async function start(name, { waitReady: wait = true, auto = false, knownState } = {}) {
  const svc = entry(name);
  // Any explicit (non-auto) start promotes the service to user-managed:
  // it will never be auto-stopped by selection changes.
  if (!auto) {
    autoStarted.delete(name);
    cancelStop(name);
  }
  const state = knownState ?? await status(name);
  if (state !== 'running') {
    const r = state === 'stopped'
      ? await docker(['start', svc.container])
      : await docker(['run', '-d', '--name', svc.container, ...svc.runArgs], 120000);
    if (r.code !== 0) return { ok: false, state, output: r.output };
  }
  if (wait && !(await waitReady(svc.ready))) {
    return { ok: false, state: 'running',
      output: `container started but ${svc.ready.target} did not become ready` };
  }
  return { ok: true, state: 'running', output: '' };
}

async function stop(name) {
  const svc = entry(name);
  autoStarted.delete(name);
  cancelStop(name);
  const r = await docker(['stop', svc.container], 30000);
  if (r.code !== 0) return { ok: false, state: await status(name), output: r.output };
  return { ok: true, state: 'stopped', output: '' };
}

// --- selection-driven lifecycle -------------------------------------------
// Services started because a selected function's playground.json declared
// them ("auto") stop GRACE_MS after no selection needs them. User-started
// services are never touched.
function graceMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS, 10);
  return Number.isFinite(parsed) ? parsed : 15000;
}

const autoStarted = new Set();
const stopTimers = new Map();

function cancelStop(name) {
  const t = stopTimers.get(name);
  if (t) {
    clearTimeout(t);
    stopTimers.delete(name);
  }
}

// setSelection can race itself: two overlapping calls previously let the
// slower one apply its start/stop bookkeeping against a `need` set captured
// before the faster, later call had run — e.g. a slow start for selection A
// resolving after a quick, unrelated selection B had already completed found
// nothing yet in `autoStarted` to schedule a stop for, so A (still holding
// its own stale need) never scheduled one either, and the service it started
// kept running until some unrelated future selection happened to reap it.
// Queueing calls means every call's bookkeeping sees the true current state.
let selectionChain = /** @type {Promise<any>} */ (Promise.resolve());

function setSelection(needed, opts) {
  const run = selectionChain.then(() => runSetSelection(needed, opts));
  selectionChain = run.catch(() => {});
  return run;
}

/**
 * @param {Iterable<string>} needed
 * @param {{ waitReady?: boolean }} [opts]
 * @returns {Promise<{ started: string[], scheduledStop: string[] }>}
 */
async function runSetSelection(needed, { waitReady: wait = true } = {}) {
  const need = new Set(needed);
  const started = [];
  const scheduledStop = [];

  for (const name of need) entry(name); // validate before touching docker
  // Cancel pending stops before the first await. Docker can be slow (or hung),
  // and a grace timer coming due mid-probe would otherwise stop a service that
  // has just been selected again.
  for (const name of need) cancelStop(name);
  // One probe for the whole selection instead of one per declared service.
  const states = need.size > 0 ? await statusAll() : null;

  for (const name of need) {
    const state = states?.get(name);
    if (state !== 'running') {
      const r = await start(name, { waitReady: wait, auto: true, knownState: state });
      if (r.ok) {
        autoStarted.add(name);
        started.push(name);
      }
    }
  }

  for (const name of autoStarted) {
    if (need.has(name) || stopTimers.has(name)) continue;
    scheduledStop.push(name);
    stopTimers.set(name, setTimeout(() => {
      stopTimers.delete(name);
      // Re-check membership: a manual start/stop may have promoted or
      // cleared it while the timer was pending.
      if (!autoStarted.has(name)) return;
      autoStarted.delete(name);
      stop(name).catch(() => {});
    }, graceMs()));
  }

  return { started, scheduledStop };
}

// Shutdown sweep: leave the machine as we found it. Only services the
// playground auto-started are stopped — anything started by hand in the
// UI (or already running before we looked) keeps running.
async function stopAutoStarted() {
  const pending = [...autoStarted];
  for (const name of pending) cancelStop(name);
  autoStarted.clear();
  const stopped = [];
  for (const name of pending) {
    const r = await stop(name).catch(() => ({ ok: false }));
    if (r.ok) stopped.push(name);
  }
  return stopped;
}

module.exports = { start, stop, setSelection, stopAutoStarted, graceMs };
