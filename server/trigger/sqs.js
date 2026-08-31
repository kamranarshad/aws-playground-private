const { requireOptional } = require('../optional-deps');
const { awsClientOptions } = require('../services/registry');
const defaultStore = require('../store');
const defaultLocalServices = require('../services');
const poller = require('./poller');

const SQS_MISSING_MESSAGE =
  'SQS triggers need `@aws-sdk/client-sqs`; run `npm i @aws-sdk/client-sqs` to enable them.';

// @aws-sdk/client-sqs is an optionalDependency -- loaded on first use (not at
// module load) so a checkout without it can still boot and use every other
// trigger type.
let _sqsSdk;
function sqsSdk() {
  if (!_sqsSdk) _sqsSdk = requireOptional('@aws-sdk/client-sqs', SQS_MISSING_MESSAGE);
  return _sqsSdk;
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
  const { SQSClient } = sqsSdk();
  return new SQSClient({ ...awsClientOptions('elasticmq'), region: 'elasticmq' });
}

async function ensureQueue(client, queueName) {
  const { CreateQueueCommand } = sqsSdk();
  const r = await client.send(new CreateQueueCommand({ QueueName: queueName }));
  return r.QueueUrl;
}

async function receiveMessage(client, queueUrl, { signal } = {}) {
  const { ReceiveMessageCommand } = sqsSdk();
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
  const { DeleteMessageCommand } = sqsSdk();
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

function start(fn, { onStatus }) {
  return poller.start(fn, {
    onStatus,
    setup: async () => {
      const client = buildClient();
      const queueUrl = await ensureQueue(client, fn.trigger.queueName);
      return {
        receive: (opts) => receiveMessage(client, queueUrl, opts),
        ack: (message) => deleteMessage(client, queueUrl, message.ReceiptHandle),
      };
    },
    buildEvent: (message) => buildSqsEvent(message, fn.trigger.queueName),
    buildSource: (message) => ({ type: 'trigger', messageId: message.MessageId }),
    invokeFunction: require('../api/invoke').invokeFunction,
  });
}

// functionId -> { queueName, stop, status } — one SQS poller per function.
// Private to this module; the manager only ever sees it through sync/stop/status.
const running = new Map();

function status(functionId) {
  return running.get(functionId)?.status;
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  return out;
}

function stop(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

async function startFor(fn, { store, localServices }) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = {
    queueName: fn.trigger.queueName,
    status: st,
    cancelled: false,
    stop: () => { record.cancelled = true; },
  };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('elasticmq', { auto: false });
    if (record.cancelled) return;
    if (!store.get(fn.id)) {
      // Function was deleted while ElasticMQ was starting up; a concurrent
      // stop(id) was a no-op since nothing was in `running` yet. Clean up
      // instead of starting a poller for a function that no longer exists.
      running.delete(fn.id);
      return;
    }
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'ElasticMQ failed to start' });
      return;
    }
    const handle = module.exports.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    if (record.cancelled) {
      handle.stop();
      return;
    }
    record.stop = handle.stop;
  } catch (err) {
    if (!record.cancelled) Object.assign(st, { state: 'error', lastError: err.message });
  }
}

// Idempotent: a no-op re-sync of an already-running, unchanged, non-error
// queue is safe to call as often as the caller likes.
async function sync(fn, trigger, deps = {}) {
  const store = deps.store ?? defaultStore;
  const localServices = deps.localServices ?? defaultLocalServices;
  const shouldRun = !!trigger.enabled;
  const current = running.get(fn.id);
  if (!shouldRun) {
    if (current) stop(fn.id);
    return;
  }
  if (current && current.queueName === trigger.queueName && current.status.state !== 'error') return;
  if (current) stop(fn.id);
  // startFor (and everything it calls) reads fn.trigger.queueName directly
  // off the object it's given — pass the resolved effective trigger through
  // fn so a playground.json-only sqs trigger (where fn.trigger itself may be
  // null or different) still reaches the right queue.
  await startFor({ ...fn, trigger }, { store, localServices });
}

module.exports = {
  type: 'sqs',
  sync, stop, status, statusAll,
  buildSqsEvent, buildClient, ensureQueue, receiveMessage, deleteMessage, start,
};
