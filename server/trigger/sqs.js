const { SQSClient, CreateQueueCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { entry, AWS_DUMMY_CREDS } = require('../services/registry');
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
    let result;
    try {
      result = await invokeFunction({
        functionId: fn.id,
        event,
        source: { type: 'trigger', messageId: message.MessageId },
      });
    } catch (err) {
      onStatus({ state: 'error', lastError: `invoke failed: ${err.message}` });
    }
    // A non-200 result means the invoke never actually ran (e.g. a 409 guard
    // for an in-flight manual invoke, or a 404 for a deleted function) — leave
    // the message on the queue for the next visibility-timeout cycle instead
    // of silently losing it. A thrown error (result stays undefined) still
    // deletes, per the established behavior above.
    if (result !== undefined && result.status !== 200) continue;
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

function buildClient() {
  const svc = entry('elasticmq');
  return new SQSClient({
    endpoint: svc.endpoint,
    region: 'elasticmq',
    credentials: {
      accessKeyId: AWS_DUMMY_CREDS.AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_DUMMY_CREDS.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function ensureQueue(client, queueName) {
  const r = await client.send(new CreateQueueCommand({ QueueName: queueName }));
  return r.QueueUrl;
}

async function receiveMessage(client, queueUrl, { signal } = {}) {
  const r = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 10,
    MessageAttributeNames: ['All'],
    AttributeNames: ['All'],
  }), { abortSignal: signal });
  return r.Messages?.[0] ?? null;
}

async function deleteMessage(client, queueUrl, receiptHandle) {
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

function start(fn, { onStatus, invokeFunction }) {
  const controller = new AbortController();
  (async () => {
    try {
      const client = buildClient();
      const queueUrl = await ensureQueue(client, fn.trigger.queueName);
      await runLoop({
        fn,
        signal: controller.signal,
        onStatus,
        receive: (opts) => receiveMessage(client, queueUrl, opts),
        remove: (receiptHandle) => deleteMessage(client, queueUrl, receiptHandle),
        invokeFunction,
      });
    } catch (err) {
      if (!controller.signal.aborted) onStatus({ state: 'error', lastError: err.message });
    }
  })();
  return { stop: () => controller.abort() };
}

module.exports = {
  buildSqsEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS,
  buildClient, ensureQueue, receiveMessage, deleteMessage, start,
};
