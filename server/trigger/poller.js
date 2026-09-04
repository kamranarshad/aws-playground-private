const inFlight = require('../api/in-flight');

const POLL_IDLE_MS = 2000;
const ERROR_BACKOFF_MS = 2000;

/** @param {number} ms @param {AbortSignal} [signal] */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

// Shared shape behind both the SQS and DynamoDB Streams pollers: an in-flight
// guard, a receive, a status patch, an invoke, and — for SQS only — an ack.
// DynamoDB Streams has no ack step (GetRecords already advanced the shard
// iterator regardless of outcome, tracked inside its own `receive`) and,
// unlike SQS's long `WaitTimeSeconds` (which IS its idle wait), GetRecords
// returns immediately on an empty batch, so it needs `sleepOnEmpty` to avoid
// hot-looping the API.
/**
 * @param {{
 *   fn: any, signal: AbortSignal, onStatus?: (patch: Partial<import('../types').PollerStatus>) => void,
 *   receive: (opts: { signal: AbortSignal }) => Promise<any>,
 *   ack?: ((batch: any) => Promise<void>) | null,
 *   buildEvent: (batch: any) => any,
 *   buildSource: (batch: any) => any,
 *   invokeFunction: (input: any) => Promise<any>,
 *   sleepOnEmpty?: boolean, idleMs?: number, errorBackoffMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} opts
 */
async function runLoop({ fn, signal, onStatus = () => {},
  receive, ack, buildEvent, buildSource, invokeFunction,
  sleepOnEmpty = false,
  idleMs = POLL_IDLE_MS, errorBackoffMs = ERROR_BACKOFF_MS, sleep = defaultSleep }) {
  while (!signal.aborted) {
    if (inFlight.has(fn.id)) {
      onStatus({ state: 'idle', lastError: null });
      try { await sleep(idleMs, signal); } catch { break; }
      continue;
    }
    let batch;
    try {
      onStatus({ state: 'polling', lastError: null });
      batch = await receive({ signal });
    } catch (err) {
      if (signal.aborted) break;
      onStatus({ state: 'error', lastError: err.message });
      try { await sleep(errorBackoffMs, signal); } catch { break; }
      continue;
    }
    onStatus({ state: 'polling', lastError: null, lastPolledAt: Date.now() });
    if (!batch) {
      if (sleepOnEmpty) { try { await sleep(idleMs, signal); } catch { break; } }
      continue;
    }
    const event = buildEvent(batch);
    let result;
    try {
      result = await invokeFunction({ functionId: fn.id, event, source: buildSource(batch) });
    } catch (err) {
      onStatus({ state: 'error', lastError: `invoke failed: ${err.message}` });
    }
    if (!ack) continue;
    // A non-200 result means the invoke never actually ran (e.g. a 409 guard
    // for an in-flight manual invoke, or a 404 for a deleted function) — leave
    // the message for the next visibility-timeout cycle instead of silently
    // losing it. A thrown error (result stays undefined) still acks, per the
    // established behavior above.
    if (result !== undefined && result.status !== 200) continue;
    try {
      await ack(batch);
    } catch (err) {
      onStatus({ state: 'error', lastError: `delete failed: ${err.message}` });
    }
  }
}

// AbortController wrapper shared by both pollers: run an async `setup` to
// build the receive/ack pair against the real client, then hand off to
// runLoop. A setup failure (or anything runLoop itself throws) is reported
// as an error status rather than an unhandled rejection, unless the poller
// was already stopped.
/**
 * @param {any} fn
 * @param {{
 *   onStatus: (patch: Partial<import('../types').PollerStatus>) => void,
 *   setup: () => Promise<{ receive: (opts: { signal: AbortSignal }) => Promise<any>,
 *                          ack?: ((batch: any) => Promise<void>) | null }>,
 *   buildEvent: (batch: any) => any,
 *   buildSource: (batch: any) => any,
 *   sleepOnEmpty?: boolean,
 *   invokeFunction: (input: any) => Promise<any>,
 * }} opts
 */
function start(fn, { onStatus, setup, buildEvent, buildSource, sleepOnEmpty, invokeFunction }) {
  const controller = new AbortController();
  (async () => {
    try {
      const { receive, ack } = await setup();
      await runLoop({
        fn, signal: controller.signal, onStatus, receive, ack, buildEvent, buildSource, sleepOnEmpty, invokeFunction,
      });
    } catch (err) {
      if (!controller.signal.aborted) onStatus({ state: 'error', lastError: err.message });
    }
  })();
  return { stop: () => controller.abort() };
}

module.exports = { defaultSleep, runLoop, start, POLL_IDLE_MS, ERROR_BACKOFF_MS };
