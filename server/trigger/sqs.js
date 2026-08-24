const inFlight = require('../api/in-flight');

const POLL_IDLE_MS = 2000;
const ERROR_BACKOFF_MS = 2000;

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

async function runLoop({ fn, signal, onStatus = () => {},
  receive, remove, invokeFunction,
  idleMs = POLL_IDLE_MS, errorBackoffMs = ERROR_BACKOFF_MS, sleep = defaultSleep }) {
  while (!signal.aborted) {
    if (inFlight.has(fn.id)) {
      onStatus({ state: 'idle', lastError: null });
      try { await sleep(idleMs, signal); } catch { break; }
      continue;
    }
    let message;
    try {
      onStatus({ state: 'polling', lastError: null });
      message = await receive({ signal });
    } catch (err) {
      if (signal.aborted) break;
      onStatus({ state: 'error', lastError: err.message });
      try { await sleep(errorBackoffMs, signal); } catch { break; }
      continue;
    }
    onStatus({ state: 'polling', lastError: null, lastPolledAt: Date.now() });
    if (!message) continue;
    const event = buildSqsEvent(message, fn.trigger.queueName);
    await invokeFunction({
      functionId: fn.id,
      event,
      source: { type: 'trigger', messageId: message.MessageId },
    });
    try {
      await remove(message.ReceiptHandle);
    } catch (err) {
      onStatus({ state: 'error', lastError: `delete failed: ${err.message}` });
    }
  }
}

function buildSqsEvent(message, queueName) {
  return {
    Records: [{
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      attributes: {
        ApproximateReceiveCount: message.Attributes?.ApproximateReceiveCount ?? '1',
        SentTimestamp: message.Attributes?.SentTimestamp ?? '',
        SenderId: message.Attributes?.SenderId ?? '',
        ApproximateFirstReceiveTimestamp: message.Attributes?.ApproximateFirstReceiveTimestamp ?? '',
      },
      messageAttributes: message.MessageAttributes ?? {},
      md5OfBody: message.MD5OfBody,
      eventSource: 'aws:sqs',
      eventSourceARN: `arn:aws:sqs:elasticmq:000000000000:${queueName}`,
      awsRegion: 'elasticmq',
    }],
  };
}

module.exports = { buildSqsEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS };
