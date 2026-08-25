# SQS Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invoke a registered function automatically when a message arrives on a local SQS (ElasticMQ) queue, with the trigger configured per-function from the UI.

**Architecture:** A new `server/trigger/` module (`sqs.js` for the poll loop and AWS SDK I/O, `manager.js` for per-function lifecycle) plugs into the existing function CRUD API and CLI startup/shutdown. It reuses `invokeFunction()` (the same call manual invokes use), `localServices.start()` (the same call the Services page's manual "Start" button uses) to keep ElasticMQ running, and `history.append()` (extended with a `source` tag) to record triggered runs.

**Tech Stack:** Node.js (CJS, `node:test`), `@aws-sdk/client-sqs` (new dependency), React/TanStack Query/TanStack Start on the web side, Vitest for web tests.

**Spec:** `docs/superpowers/specs/2026-08-24-sqs-trigger-design.md`

## Global Constraints

- Node >= 22.12 (existing `package.json` engines field — unaffected).
- npm is the canonical package manager for this repo.
- Trigger `type` is fixed to `'sqs'` for v1 — the field name (`trigger`, not `sqsTrigger`) stays generic so a future S3 trigger type needs no migration.
- One message per invoke — no batching.
- The message is deleted after every invoke, success or failure — no redelivery/DLQ in v1.
- The queue is auto-created if it doesn't exist (`CreateQueueCommand`, idempotent).
- Trigger config lives only in `functions.json` (set via the UI) — no `playground.json` support in v1.
- Enabling a trigger promotes ElasticMQ to user-managed (via `localServices.start(name, { auto: false })`) so it is never auto-stopped by the existing 15s selection-driven grace timer; disabling a trigger does not stop the service.
- New dependency: `@aws-sdk/client-sqs` — the server has no runtime dependencies today, this is the first.

---

### Task 1: Data model — `trigger` field + validation

**Files:**
- Modify: `server/store.js`
- Modify: `server/api/functions.js`
- Test: `tests/store.test.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Produces: `FunctionRecord.trigger: { type: 'sqs', queueName: string, enabled: boolean } | null`, persisted and round-tripped by `store.create`/`store.update`. Later tasks (manager, API) read `fn.trigger`.

- [ ] **Step 1: Write the failing test in `tests/store.test.js`**

Add at the end of the file:

```js
test('trigger field defaults to null and round-trips through create/update', () => {
  const fn = store.create({ name: 'trig1', path: '/tmp/trig1', runtime: 'node' });
  assert.strictEqual(fn.trigger, null);
  const withTrigger = store.create({ name: 'trig2', path: '/tmp/trig2', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: true } });
  assert.deepStrictEqual(withTrigger.trigger, { type: 'sqs', queueName: 'q', enabled: true });
  const updated = store.update(withTrigger.id, { trigger: { type: 'sqs', queueName: 'q2', enabled: false } });
  assert.deepStrictEqual(updated.trigger, { type: 'sqs', queueName: 'q2', enabled: false });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL — `fn.trigger` is `undefined` (create doesn't set it), and `update`'s patch is silently dropped (not in `ALLOWED_KEYS`).

- [ ] **Step 3: Implement in `server/store.js`**

Change the `ALLOWED_KEYS` array:

```js
const ALLOWED_KEYS = ['name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'envFile', 'buildCommand', 'localServices',
  'savedEvents', 'trigger'];
```

In `create()`, add the field to the object literal (after `savedEvents`):

```js
    savedEvents: input.savedEvents ?? [],
    trigger: input.trigger ?? null,
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/store.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing validation test in `tests/api.test.js`**

Add after the existing `'function CRUD with validation'` test:

```js
test('trigger field validation on create and update', () => {
  let r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sns', queueName: 'q', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: '', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: 'yes' } });
  assert.strictEqual(r.status, 400);

  r = api.createFunction({ name: 'trig', path: FIXTURES, runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q', enabled: false } });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;
  assert.deepStrictEqual(r.body.trigger, { type: 'sqs', queueName: 'q', enabled: false });

  r = api.updateFunction(id, { trigger: { type: 'sqs', queueName: '', enabled: true } });
  assert.strictEqual(r.status, 400);

  r = api.updateFunction(id, { trigger: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.trigger, null);
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL — invalid trigger shapes are accepted (no validation yet).

- [ ] **Step 7: Implement in `server/api/functions.js`**

Add a helper function above `fieldError`:

```js
function triggerError(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (trigger.type !== 'sqs') return `unsupported trigger type '${trigger.type}'`;
  if (typeof trigger.queueName !== 'string' || !trigger.queueName.trim()) {
    return 'trigger.queueName is required';
  }
  if (typeof trigger.enabled !== 'boolean') return 'trigger.enabled must be a boolean';
  return null;
}
```

Inside `fieldError(fields)`, add a check (after the `memoryMb` check, before `return null`):

```js
  if ('trigger' in fields) {
    const triggerErr = triggerError(fields.trigger);
    if (triggerErr) return triggerErr;
  }
```

- [ ] **Step 8: Run it, confirm it passes**

Run: `node --test tests/store.test.js tests/api.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/store.js server/api/functions.js tests/store.test.js tests/api.test.js
git commit -m "feat(server): add validated trigger field to function records"
```

---

### Task 2: History source tagging

**Files:**
- Modify: `server/history.js`
- Modify: `server/api/invoke.js`
- Test: `tests/history.test.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `history.append(functionId, entry)` now stores `entry.source ?? { type: 'manual' }` as `stored.source`. `invokeFunction(input)` accepts an optional `input.source: { type: 'manual' } | { type: 'trigger', messageId: string }`, defaulting to `{ type: 'manual' }`, threaded into every `history.append` call it makes. Task 5's poll loop will call `invokeFunction({ functionId, event, source: { type: 'trigger', messageId } })`.

- [ ] **Step 1: Write the failing test in `tests/history.test.js`**

Add after the `'small entries are not flagged truncated'` test:

```js
test('append defaults source to manual and preserves an explicit trigger source', () => {
  const manual = history.append('fn11', entry());
  assert.deepStrictEqual(manual.source, { type: 'manual' });
  const triggered = history.append('fn11', entry({ source: { type: 'trigger', messageId: 'm1' } }));
  assert.deepStrictEqual(triggered.source, { type: 'trigger', messageId: 'm1' });
  const listed = history.list('fn11');
  assert.deepStrictEqual(listed[0].source, { type: 'trigger', messageId: 'm1' });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/history.test.js`
Expected: FAIL — `stored.source` is `undefined`.

- [ ] **Step 3: Implement in `server/history.js`**

In `append()`, add `source` to the `stored` object literal (right after `handler`):

```js
    handler: entry.handler ?? '',
    source: entry.source ?? { type: 'manual' },
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/history.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing test in `tests/api.test.js`**

Add after the `'invoke returns result; unknown id 404'` test:

```js
test('invokeFunction tags history with the given source, defaulting to manual', { skip: noPy }, async () => {
  const created = api.createFunction({ name: 'hello3', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  await api.invokeFunction({ functionId: created.body.id, event: {} });
  await api.invokeFunction({ functionId: created.body.id, event: {},
    source: { type: 'trigger', messageId: 'm1' } });
  const entries = api.listHistory(created.body.id).body.entries;
  assert.deepStrictEqual(entries[0].source, { type: 'trigger', messageId: 'm1' });
  assert.deepStrictEqual(entries[1].source, { type: 'manual' });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL (skipped if no python3; otherwise FAIL — `entries[0].source` is always `{ type: 'manual' }`).

- [ ] **Step 7: Implement in `server/api/invoke.js`**

Change the destructure at the top of `invokeFunction`:

```js
  const { functionId, source } = input || {};
```

In the "service not running" early-return `history.append` call, add `source` to the object:

```js
          history.append(fn.id, {
            handler: input.handler ?? fn.handler, event: input.event ?? {},
            response: undefined, error: result.error, logs: '',
            report: result.report, durationMs: 0, ok: false,
            source: source ?? { type: 'manual' },
          });
```

In the main success/failure `history.append` call, add `source` to the object:

```js
      history.append(fn.id, {
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
        response: result.response,
        error: result.error ?? null,
        logs: result.logs,
        report: result.report,
        durationMs: result.report.durationMs,
        ok: result.ok,
        source: source ?? { type: 'manual' },
      });
```

- [ ] **Step 8: Run it, confirm it passes**

Run: `node --test tests/history.test.js tests/api.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/history.js server/api/invoke.js tests/history.test.js tests/api.test.js
git commit -m "feat(server): tag history entries with their invoke source"
```

---

### Task 3: SQS event builder

**Files:**
- Create: `server/trigger/sqs.js`
- Test: `tests/trigger-sqs.test.js`

**Interfaces:**
- Produces: `buildSqsEvent(message, queueName) -> { Records: [...] }`, where `message` is an SQS SDK `Message` shape (`MessageId`, `ReceiptHandle`, `Body`, `MD5OfBody`, `Attributes?`, `MessageAttributes?`). Task 4 (`runLoop`) and Task 5 (`start`) both call this.

- [ ] **Step 1: Write the failing test in `tests/trigger-sqs.test.js`** (new file)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSqsEvent } = require('../server/trigger/sqs');

function message(overrides = {}) {
  return {
    MessageId: 'm1',
    ReceiptHandle: 'rh1',
    Body: '{"hello":"world"}',
    MD5OfBody: 'abc123',
    Attributes: {
      ApproximateReceiveCount: '2',
      SentTimestamp: '1700000000000',
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: '1700000000100',
    },
    MessageAttributes: {},
    ...overrides,
  };
}

test('buildSqsEvent shapes a real Lambda SQS event Records array', () => {
  const event = buildSqsEvent(message(), 'my-queue');
  assert.strictEqual(event.Records.length, 1);
  const record = event.Records[0];
  assert.strictEqual(record.messageId, 'm1');
  assert.strictEqual(record.receiptHandle, 'rh1');
  assert.strictEqual(record.body, '{"hello":"world"}');
  assert.strictEqual(record.md5OfBody, 'abc123');
  assert.strictEqual(record.eventSource, 'aws:sqs');
  assert.strictEqual(record.eventSourceARN, 'arn:aws:sqs:elasticmq:000000000000:my-queue');
  assert.strictEqual(record.awsRegion, 'elasticmq');
  assert.deepStrictEqual(record.attributes, {
    ApproximateReceiveCount: '2',
    SentTimestamp: '1700000000000',
    SenderId: 'AIDAEXAMPLE',
    ApproximateFirstReceiveTimestamp: '1700000000100',
  });
});

test('buildSqsEvent fills in safe defaults when SQS omits optional attributes', () => {
  const event = buildSqsEvent(message({ Attributes: undefined, MessageAttributes: undefined }), 'my-queue');
  assert.deepStrictEqual(event.Records[0].attributes, {
    ApproximateReceiveCount: '1', SentTimestamp: '', SenderId: '', ApproximateFirstReceiveTimestamp: '',
  });
  assert.deepStrictEqual(event.Records[0].messageAttributes, {});
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/trigger-sqs.test.js`
Expected: FAIL — `server/trigger/sqs.js` doesn't exist yet (`Cannot find module`).

- [ ] **Step 3: Implement `server/trigger/sqs.js`**

```js
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

module.exports = { buildSqsEvent };
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/trigger-sqs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/trigger/sqs.js tests/trigger-sqs.test.js
git commit -m "feat(server): build a real Lambda SQS event shape from an ElasticMQ message"
```

---

### Task 4: Poll loop (`runLoop`), fully hermetic

**Files:**
- Modify: `server/trigger/sqs.js`
- Test: `tests/trigger-sqs.test.js`

**Interfaces:**
- Consumes: `buildSqsEvent` (Task 3), `server/api/in-flight` (existing `Set`).
- Produces: `runLoop({ fn, signal, onStatus, receive, remove, invokeFunction, idleMs, errorBackoffMs, sleep })`. `receive({ signal }) -> Promise<Message|null>`, `remove(receiptHandle) -> Promise<void>`, `invokeFunction(input) -> Promise<any>` are all caller-injected (Task 5's `start()` wires the real SQS client to these; tests inject fakes). `onStatus(patch)` is called with partial `{ state: 'idle'|'polling'|'error', lastError?, lastPolledAt? }` objects. Also exports `POLL_IDLE_MS`, `ERROR_BACKOFF_MS` (both `2000`).

- [ ] **Step 1: Write the failing tests — append to `tests/trigger-sqs.test.js`**

```js
const { runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS } = require('../server/trigger/sqs');
const inFlight = require('../server/api/in-flight');

test('idle and error backoff default to a couple of seconds', () => {
  assert.strictEqual(POLL_IDLE_MS, 2000);
  assert.strictEqual(ERROR_BACKOFF_MS, 2000);
});

test('runLoop invokes the function for a received message and deletes it', async () => {
  const controller = new AbortController();
  const calls = { invoke: [], remove: [] };
  const receive = async () => ({ MessageId: 'm1', ReceiptHandle: 'rh1', Body: 'x', MD5OfBody: 'y' });
  const remove = async (rh) => { calls.remove.push(rh); controller.abort(); };
  const invokeFunction = async (input) => { calls.invoke.push(input); return { status: 200 }; };

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } },
    signal: controller.signal,
    receive, remove, invokeFunction,
  });

  assert.strictEqual(calls.invoke.length, 1);
  assert.strictEqual(calls.invoke[0].functionId, 'fn1');
  assert.deepStrictEqual(calls.invoke[0].source, { type: 'trigger', messageId: 'm1' });
  assert.strictEqual(calls.invoke[0].event.Records[0].messageId, 'm1');
  assert.deepStrictEqual(calls.remove, ['rh1']);
});

test('runLoop deletes the message even when the invoke fails', async () => {
  const controller = new AbortController();
  const removed = [];
  const receive = async () => ({ MessageId: 'm1', ReceiptHandle: 'rh1', Body: 'x' });
  const remove = async (rh) => { removed.push(rh); controller.abort(); };
  const invokeFunction = async () => ({ status: 500 });

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove, invokeFunction,
  });

  assert.deepStrictEqual(removed, ['rh1']);
});

test('runLoop skips a poll cycle while the function is already in flight', async () => {
  const controller = new AbortController();
  inFlight.add('fn1');
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return null; };
  const statuses = [];
  const sleep = async () => { inFlight.delete('fn1'); controller.abort(); };

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s), sleep,
  });

  assert.strictEqual(receiveCalls, 0);
  assert.ok(statuses.some((s) => s.state === 'idle'));
});

test('runLoop backs off and retries after a receive error, without crashing', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const receive = async () => {
    attempts++;
    if (attempts === 1) throw new Error('connection refused');
    controller.abort();
    return null;
  };
  const statuses = [];
  const sleep = async () => {};

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s), sleep,
  });

  assert.strictEqual(attempts, 2);
  assert.ok(statuses.some((s) => s.state === 'error' && s.lastError === 'connection refused'));
});

test('runLoop exits cleanly when aborted mid-receive', async () => {
  const controller = new AbortController();
  const receive = async () => {
    controller.abort();
    throw new Error('aborted');
  };
  const statuses = [];

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s),
  });

  assert.ok(!statuses.some((s) => s.state === 'error'));
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/trigger-sqs.test.js`
Expected: FAIL — `runLoop` is not exported.

- [ ] **Step 3: Implement — add to `server/trigger/sqs.js`**

Add near the top of the file (after nothing, this is the first `require`):

```js
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
```

Change the final `module.exports` line to:

```js
module.exports = { buildSqsEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS };
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/trigger-sqs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/trigger/sqs.js tests/trigger-sqs.test.js
git commit -m "feat(server): add the SQS poll loop with in-flight skip and error backoff"
```

---

### Task 5: SQS client I/O + `start()` glue

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install`)
- Modify: `server/trigger/sqs.js`

**Interfaces:**
- Consumes: `../services/registry` (`entry('elasticmq')` for endpoint/credentials — already used by `server/services/index.js`), `runLoop` (Task 4), `../api/invoke`'s `invokeFunction`.
- Produces: `start(fn, { onStatus }) -> { stop: () => void }` — builds a real SQS client, ensures the queue exists, and runs `runLoop` until `stop()` is called. Task 6 (`manager.js`) is the only caller.

No new unit test in this task: `buildClient`/`ensureQueue`/`receiveMessage`/`deleteMessage`/`start` are thin wrappers around the real `@aws-sdk/client-sqs` client — meaningfully testing them requires a live ElasticMQ, which Task 9's real-docker test provides end-to-end. `runLoop`'s own logic is already covered hermetically by Task 4.

- [ ] **Step 1: Install the new dependency**

Run: `npm install @aws-sdk/client-sqs`
Expected: `package.json` gains a new `dependencies` entry for `@aws-sdk/client-sqs`; `package-lock.json` updates.

- [ ] **Step 2: Implement — add to `server/trigger/sqs.js`**

Add the import at the very top of the file:

```js
const { SQSClient, CreateQueueCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { entry } = require('../services/registry');
```

Add after `buildSqsEvent`:

```js
function buildClient() {
  const svc = entry('elasticmq');
  return new SQSClient({
    endpoint: svc.endpoint,
    region: 'elasticmq',
    credentials: { accessKeyId: 'playground', secretAccessKey: 'playground123' },
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

function start(fn, { onStatus }) {
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
        invokeFunction: require('../api/invoke').invokeFunction,
      });
    } catch (err) {
      if (!controller.signal.aborted) onStatus({ state: 'error', lastError: err.message });
    }
  })();
  return { stop: () => controller.abort() };
}
```

Change the final `module.exports` line to:

```js
module.exports = {
  buildSqsEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS,
  buildClient, ensureQueue, receiveMessage, deleteMessage, start,
};
```

- [ ] **Step 3: Confirm nothing else broke**

Run: `npm run test:server`
Expected: PASS (all prior tests still pass — this task only adds new exports).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server/trigger/sqs.js
git commit -m "feat(server): wire the SQS poll loop to a real ElasticMQ client"
```

---

### Task 6: Trigger manager

**Files:**
- Create: `server/trigger/manager.js`
- Test: `tests/trigger-manager.test.js`

**Interfaces:**
- Consumes: `../store` (`list`, existing), `../services` (`start`, existing — same call the Services page's manual "Start" button makes), `./sqs` (`start`, Task 5 — called as `sqs.start(...)`, never destructured, so tests can override the property).
- Produces: `sync(fn) -> Promise<void>`, `stop(functionId) -> void`, `resumeAll() -> Promise<void>`, `stopAll() -> void`, `status(functionId) -> { state, lastError, lastPolledAt }`, `statusAll() -> Record<functionId, status>`. Task 7 (API wiring), Task 8 (CLI wiring) call these.

- [ ] **Step 1: Write the failing tests in `tests/trigger-manager.test.js`** (new file)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDockerShim, writeScenario } = require('./helpers');

// Hermetic like tests/services.test.js: a shim "docker" for the elasticmq
// start (localServices.start), and a monkeypatched sqs.start for the poll
// loop itself — real network/docker is exercised by tests/trigger-docker.test.js.
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-'));
const { shim: SHIM, scenario: SCENARIO, calls: CALLS } = writeDockerShim(SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-data-'));

function scenario(map) {
  writeScenario(SCENARIO, map);
  fs.writeFileSync(CALLS, '');
}

function elasticmqAlreadyRunning() {
  scenario({ inspect: { code: 0, stdout: 'true' } });
}

const sqs = require('../server/trigger/sqs');
const store = require('../server/store');
const manager = require('../server/trigger/manager');

test('sync starts elasticmq and the poll loop when a trigger is enabled', async () => {
  elasticmqAlreadyRunning();
  const stop = () => { stop.called = true; };
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
  const fn = store.create({ name: 'f1', path: '/tmp/f1', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q1', enabled: true } });

  await manager.sync(fn);

  assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
  manager.stop(fn.id);
  assert.strictEqual(stop.called, true);
});

test('sync is a no-op when the trigger is already running with the same queue', async () => {
  elasticmqAlreadyRunning();
  let starts = 0;
  sqs.start = (fn, { onStatus }) => { starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
  const fn = store.create({ name: 'f2', path: '/tmp/f2', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q2', enabled: true } });

  await manager.sync(fn);
  await manager.sync(fn);

  assert.strictEqual(starts, 1);
  manager.stop(fn.id);
});

test('sync restarts the loop when the queue name changes', async () => {
  elasticmqAlreadyRunning();
  const stopped = [];
  let n = 0;
  sqs.start = (fn, { onStatus }) => {
    n++;
    const id = n;
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => stopped.push(id) };
  };
  let fn = store.create({ name: 'f3', path: '/tmp/f3', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q3', enabled: true } });
  await manager.sync(fn);
  fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q3-renamed', enabled: true } });
  await manager.sync(fn);

  assert.deepStrictEqual(stopped, [1]);
  assert.strictEqual(n, 2);
  manager.stop(fn.id);
});

test('sync stops the loop when the trigger is disabled', async () => {
  elasticmqAlreadyRunning();
  let stopped = false;
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } }; };
  let fn = store.create({ name: 'f4', path: '/tmp/f4', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q4', enabled: true } });
  await manager.sync(fn);
  fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q4', enabled: false } });
  await manager.sync(fn);

  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
});

test('a service start failure is reported as an error status, not thrown', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 125, stdout: 'port is already allocated' } });
  const fn = store.create({ name: 'f5', path: '/tmp/f5', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q5', enabled: true } });

  await manager.sync(fn);

  const st = manager.status(fn.id);
  assert.strictEqual(st.state, 'error');
  assert.match(st.lastError, /port is already allocated/);
  manager.stop(fn.id);
});

test('resumeAll starts a poller for every function with an enabled trigger; stopAll tears them all down', async () => {
  elasticmqAlreadyRunning();
  const started = [];
  sqs.start = (fn, { onStatus }) => {
    started.push(fn.id);
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => {} };
  };
  const a = store.create({ name: 'a', path: '/tmp/a', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'qa', enabled: true } });
  const b = store.create({ name: 'b', path: '/tmp/b', runtime: 'node' });

  await manager.resumeAll();

  assert.ok(started.includes(a.id));
  assert.ok(!started.includes(b.id));
  manager.stopAll();
  assert.deepStrictEqual(manager.status(a.id), { state: 'idle', lastError: null, lastPolledAt: null });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/trigger-manager.test.js`
Expected: FAIL — `server/trigger/manager.js` doesn't exist yet.

- [ ] **Step 3: Implement `server/trigger/manager.js`**

```js
const store = require('../store');
const localServices = require('../services');
const sqs = require('./sqs');

// functionId -> { queueName, stop, status }
const running = new Map();

function status(functionId) {
  return running.get(functionId)?.status ?? { state: 'idle', lastError: null, lastPolledAt: null };
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  return out;
}

async function startFor(fn) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = { queueName: fn.trigger.queueName, stop: () => {}, status: st };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('elasticmq', { auto: false });
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'ElasticMQ failed to start' });
      return;
    }
    const handle = sqs.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
    record.stop = handle.stop;
  } catch (err) {
    Object.assign(st, { state: 'error', lastError: err.message });
  }
}

function stop(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

async function sync(fn) {
  const shouldRun = !!(fn.trigger && fn.trigger.enabled);
  const current = running.get(fn.id);
  if (!shouldRun) {
    if (current) stop(fn.id);
    return;
  }
  if (current && current.queueName === fn.trigger.queueName) return;
  if (current) stop(fn.id);
  await startFor(fn);
}

async function resumeAll() {
  for (const fn of store.list()) await sync(fn);
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { sync, stop, resumeAll, stopAll, status, statusAll };
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/trigger-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/trigger/manager.js tests/trigger-manager.test.js
git commit -m "feat(server): add the per-function trigger lifecycle manager"
```

---

### Task 7: API wiring

**Files:**
- Modify: `server/api/functions.js`
- Create: `server/api/triggers.js`
- Modify: `server/api/index.js`
- Create: `web/src/routes/api.triggers.ts`
- Modify: `web/src/routes/api.functions.$id.ts` (no change needed — see note below)
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `../trigger/manager` (`sync`, `stop`, `statusAll` — Task 6).
- Produces: `listTriggerStatus() -> { status: 200, body: manager.statusAll() }`, exported from `server/api/index.js`. `updateFunction`/`deleteFunction` now notify the manager. `GET /api/triggers` route.

Note: `createFunction` deliberately does **not** call `manager.sync` — a newly created function always has `trigger: null` (the UI's "Add function" dialog has no trigger fields; trigger is only ever set later via the Settings dialog's `PATCH`), so there's nothing to start.

- [ ] **Step 1: Write the failing tests in `tests/api.test.js`**

Add after the `'trigger field validation on create and update'` test from Task 1:

```js
test('updating a function trigger notifies the trigger manager; deleting stops it', () => {
  const manager = require('../server/trigger/manager');
  const calls = { sync: [], stop: [] };
  const originalSync = manager.sync;
  const originalStop = manager.stop;
  manager.sync = (fn) => calls.sync.push(fn.id);
  manager.stop = (id) => calls.stop.push(id);
  try {
    const created = api.createFunction({ name: 'trigwire', path: FIXTURES, runtime: 'node' });
    const id = created.body.id;
    assert.deepStrictEqual(calls.sync, []);

    api.updateFunction(id, { trigger: { type: 'sqs', queueName: 'q', enabled: true } });
    assert.deepStrictEqual(calls.sync, [id]);

    api.deleteFunction(id);
    assert.deepStrictEqual(calls.stop, [id]);
  } finally {
    manager.sync = originalSync;
    manager.stop = originalStop;
  }
});

test('GET /api/triggers reports manager status', () => {
  const manager = require('../server/trigger/manager');
  const original = manager.statusAll;
  manager.statusAll = () => ({ someId: { state: 'polling', lastError: null, lastPolledAt: 123 } });
  try {
    const r = api.listTriggerStatus();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { someId: { state: 'polling', lastError: null, lastPolledAt: 123 } });
  } finally {
    manager.statusAll = original;
  }
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL — `manager.sync`/`manager.stop` are never called; `api.listTriggerStatus` is not a function.

- [ ] **Step 3: Create `server/api/triggers.js`**

```js
const manager = require('../trigger/manager');

function listTriggerStatus() {
  return { status: 200, body: manager.statusAll() };
}

module.exports = { listTriggerStatus };
```

- [ ] **Step 4: Implement in `server/api/functions.js`**

Add the require at the top:

```js
const manager = require('../trigger/manager');
```

Change `updateFunction`:

```js
function updateFunction(id, patch) {
  const p = patch || {};
  const err = fieldError(p);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.update(id, p);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  manager.sync(fn);
  return { status: 200, body: fn };
}
```

Change `deleteFunction`:

```js
function deleteFunction(id) {
  if (inFlight.has(id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  manager.stop(id);
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}
```

- [ ] **Step 5: Wire into `server/api/index.js`**

```js
const { health } = require('./health');
const { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect } = require('./functions');
const { invokeFunction } = require('./invoke');
const { listServices, startService, stopService, setSelection } = require('./services');
const { listHistory, clearHistory } = require('./history');
const { listTriggerStatus } = require('./triggers');

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory,
  listServices, startService, stopService, setSelection, listTriggerStatus, RUNTIMES };
```

- [ ] **Step 6: Run it, confirm it passes**

Run: `node --test tests/api.test.js`
Expected: PASS

- [ ] **Step 7: Add the web route — create `web/src/routes/api.triggers.ts`**

```ts
import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/triggers')({
  server: {
    handlers: {
      GET: async () => toResponse(await backend.listTriggerStatus()),
    },
  },
})
```

- [ ] **Step 8: Commit**

```bash
git add server/api/functions.js server/api/triggers.js server/api/index.js \
  web/src/routes/api.triggers.ts tests/api.test.js
git commit -m "feat(server): wire trigger lifecycle into the function CRUD API"
```

---

### Task 8: CLI startup/shutdown wiring

**Files:**
- Modify: `bin/cli.js`

**Interfaces:**
- Consumes: `server/trigger/manager` (`resumeAll`, `stopAll` — Task 6).

- [ ] **Step 1: Implement in `bin/cli.js`**

Add the require near the top (with the other `server/` requires):

```js
const triggerManager = require('../server/trigger/manager');
```

In `installShutdownSweep`'s `bye()`, call `stopAll()` before the services sweep:

```js
  const bye = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    triggerManager.stopAll();
    try {
      const stopped = await localServices.stopAutoStarted();
```

In the `startWebServer(...).then(...)` callback, resume persisted triggers right after `installShutdownSweep(server)`:

```js
  .then((server) => {
    installShutdownSweep(server);
    triggerManager.resumeAll().catch((err) => {
      console.warn(`aws-playground: could not resume triggers: ${err.message}`);
    });
    const url = `http://localhost:${server.address().port}`;
```

- [ ] **Step 2: Confirm nothing else broke**

Run: `npm run test:server`
Expected: PASS — `tests/cli.test.js` still passes (it doesn't exercise triggers, but must not regress).

- [ ] **Step 3: Manual verification** (no automated CLI-level test — this wiring needs a real ElasticMQ, which `tests/trigger-docker.test.js` in Task 9 exercises against the `manager`/`sqs` modules directly, faster than spawning the CLI)

1. `npm start`
2. Register a function (e.g. `fixtures/python/hello`), open its Settings, set an SQS trigger queue name (e.g. `manual-test`), enable it, Save.
3. Confirm the ElasticMQ service shows "running" on the Services page.
4. Send a message: `aws --endpoint-url http://127.0.0.1:9324 sqs send-message --queue-url http://127.0.0.1:9324/queue/manual-test --message-body '{"hi":1}'` (create the queue first via `aws --endpoint-url http://127.0.0.1:9324 sqs create-queue --queue-name manual-test` if needed — the playground also auto-creates it once the trigger is enabled).
5. Confirm a new entry tagged "trigger" appears in the History tab within ~10s.
6. `Ctrl+C` the playground, restart with `npm start`, and confirm the trigger is still enabled in Settings and a second message is picked up without re-toggling anything.

- [ ] **Step 4: Commit**

```bash
git add bin/cli.js
git commit -m "feat: resume trigger polling on startup, stop it on shutdown"
```

---

### Task 9: Real-docker end-to-end test

**Files:**
- Create: `tests/trigger-docker.test.js`

**Interfaces:**
- Consumes: `server/api` (`createFunction`, `updateFunction`, `listHistory`), `server/trigger/manager` (`sync`, `stop`, `stopAll`, `resumeAll`), `@aws-sdk/client-sqs` directly (to send messages as an external producer would).

- [ ] **Step 1: Write the test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');
const {
  SQSClient, CreateQueueCommand, SendMessageCommand, GetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');

function imagePresent(image) {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const daemonUp = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();

const ready = daemonUp && imagePresent('softwaremill/elasticmq-native') && hasRuntime('python3');

delete process.env.AWS_PLAYGROUND_DOCKER; // real docker, not a shim
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-e2e-'));

const api = require('../server/api');
const manager = require('../server/trigger/manager');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function sqsClient() {
  return new SQSClient({
    endpoint: 'http://127.0.0.1:9324',
    region: 'elasticmq',
    credentials: { accessKeyId: 'playground', secretAccessKey: 'playground123' },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTriggerEntry(functionId, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const entry = api.listHistory(functionId).body.entries.find((e) => e.source?.type === 'trigger');
    if (entry) return entry;
    await sleep(1000);
  }
  return null;
}

test('enabling a trigger invokes the function when a message arrives, deletes it, and tags history',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-queue', enabled: true } }).body;
  await manager.sync(fn);

  const client = sqsClient();
  const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-queue' }));
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify({ hello: 'world' }) }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry, 'expected a trigger-sourced history entry');
  assert.strictEqual(entry.source.messageId.length > 0, true);
  assert.strictEqual(entry.event.Records[0].body, JSON.stringify({ hello: 'world' }));
  assert.strictEqual(entry.event.Records[0].eventSource, 'aws:sqs');
  assert.strictEqual(entry.ok, true);

  const attrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  assert.strictEqual(attrs.Attributes.ApproximateNumberOfMessages, '0');

  manager.stop(fn.id);
});

test('disabling a trigger stops consuming — the message is left on the queue',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-disable', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  let fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-disable-queue', enabled: true } }).body;
  await manager.sync(fn);

  fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-disable-queue', enabled: false } }).body;
  await manager.sync(fn);

  const client = sqsClient();
  const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-disable-queue' }));
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: 'untouched' }));
  await sleep(3000);

  const before = api.listHistory(fn.id).body.entries.filter((e) => e.source?.type === 'trigger');
  assert.strictEqual(before.length, 0);
  const attrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  assert.strictEqual(attrs.Attributes.ApproximateNumberOfMessages, '1');
});

test('resumeAll resumes a previously enabled trigger after a simulated restart',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-resume', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-resume-queue', enabled: true } }).body;
  await manager.sync(fn);
  manager.stopAll(); // simulate shutdown

  await manager.resumeAll(); // simulate a fresh process reading functions.json

  const client = sqsClient();
  const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-resume-queue' }));
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: 'after-restart' }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry, 'expected the resumed trigger to pick up the message');

  manager.stopAll();
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/trigger-docker.test.js`
Expected: PASS if docker + the `softwaremill/elasticmq-native` image + python3 are available locally; otherwise SKIP with a clear reason (matches `tests/services-docker.test.js`'s existing pattern — pull the image once with `docker pull softwaremill/elasticmq-native` to exercise this for real).

- [ ] **Step 3: Run the full server suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/trigger-docker.test.js
git commit -m "test: cover the SQS trigger end-to-end against real ElasticMQ"
```

---

### Task 10: Web foundations — types, API client, hooks, route

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/queries.ts`
- Test: `web/src/lib/queries.test.tsx`

**Interfaces:**
- Produces: `FunctionDef.trigger: FunctionTrigger | null`, `HistoryEntry.source: InvokeSource`, `TriggerStatus`, `TriggersStatus`, `api.listTriggerStatus()`, `useTriggerStatus()`. Tasks 11–13 consume these.

- [ ] **Step 1: Implement types — `web/src/lib/types.ts`**

Add near the top, after `SavedEvent`:

```ts
export interface FunctionTrigger {
  type: 'sqs'
  queueName: string
  enabled: boolean
}
```

Add `trigger` to `FunctionDef` (after `localServices`):

```ts
  localServices: string[]
  trigger: FunctionTrigger | null
```

Add after `ServicesStatus`:

```ts
export interface TriggerStatus {
  state: 'idle' | 'polling' | 'error'
  lastError: string | null
  lastPolledAt: number | null
}

export type TriggersStatus = Record<string, TriggerStatus>
```

Add before `HistoryEntry`:

```ts
export type InvokeSource = { type: 'manual' } | { type: 'trigger'; messageId: string }
```

Add `source` to `HistoryEntry` (after `handler`):

```ts
  handler: string
  source: InvokeSource
```

- [ ] **Step 2: Implement the API client — `web/src/lib/api.ts`**

Update the type import:

```ts
import type {
  Detection, FunctionDef, Health, HistoryEntry, InvokeResult, ServicesStatus, TriggersStatus,
} from './types'
```

Add to the `api` object (after `stopService`):

```ts
  listTriggerStatus: () => request<TriggersStatus>('/api/triggers'),
```

- [ ] **Step 3: Write the failing test — extend `web/src/lib/queries.test.tsx`**

Update the `vi.mock('@/lib/api', ...)` block to add `listTriggerStatus`:

```ts
vi.mock('@/lib/api', () => ({
  api: {
    listServices: vi.fn().mockResolvedValue({
      docker: { available: true },
      services: [],
    }),
    listTriggerStatus: vi.fn().mockResolvedValue({}),
  },
}))
```

Update the hook import:

```ts
import { useReleaseSelectionOnUnload, useServices, useTriggerStatus } from '@/lib/queries'
```

Add a new test after the `'polls the services list...'` test:

```tsx
it('polls the trigger status so a poller that errors out stops showing as healthy', async () => {
  vi.useFakeTimers()
  renderHook(() => useTriggerStatus(), { wrapper: makeWrapper() })

  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(api.listTriggerStatus).toHaveBeenCalledTimes(1)

  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(api.listTriggerStatus).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 4: Run it, confirm it fails**

Run: `npm --prefix web run test -- queries.test.tsx`
Expected: FAIL — `useTriggerStatus` is not exported.

- [ ] **Step 5: Implement the hook — `web/src/lib/queries.ts`**

Add after `useServices`:

```ts
export function useTriggerStatus() {
  return useQuery({
    queryKey: ['triggers'],
    queryFn: api.listTriggerStatus,
    refetchInterval: SERVICES_POLL_MS,
  })
}
```

- [ ] **Step 6: Run it, confirm it passes**

Run: `npm --prefix web run test -- queries.test.tsx`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `npm --prefix web run build` (runs the TanStack Start build, which typechecks)
Expected: succeeds (or run the project's dedicated web typecheck script if `package.json` has one — check `web/package.json` `scripts` for a `typecheck` entry and prefer that if present).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/src/lib/queries.ts web/src/lib/queries.test.tsx
git commit -m "feat(web): add trigger types, API client, and polling hook"
```

---

### Task 11: Settings dialog — Trigger section

**Files:**
- Modify: `web/src/components/settings-dialog.tsx`
- Test: `web/src/components/settings-dialog.test.tsx`

**Interfaces:**
- Consumes: `FunctionDef.trigger` (Task 10), `Checkbox` (`web/src/components/ui/checkbox.tsx`, existing).

- [ ] **Step 1: Write the failing tests — extend `web/src/components/settings-dialog.test.tsx`**

Update the `fn` fixture to include `trigger`:

```ts
const fn: FunctionDef = {
  id: 'fn1', name: 'test', path: '/tmp/test', runtime: 'node',
  handler: 'index.handler', timeoutMs: 30000, memoryMb: 128, jarPath: null,
  env: {}, envFile: 'auto', buildCommand: '', localServices: [], savedEvents: [],
  trigger: null,
}
```

Add new tests at the end of the file:

```tsx
it('seeds the trigger fields from the function', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  await openSettings()
  expect(screen.getByLabelText('SQS trigger queue')).toHaveValue('my-queue')
  expect(screen.getByRole('checkbox', { name: /invoke automatically/i })).toBeChecked()
})

it('saves the trigger config through the patch', async () => {
  render(<SettingsDialog fn={fn} />, { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.type(screen.getByLabelText('SQS trigger queue'), 'new-queue')
  await user.click(screen.getByRole('checkbox', { name: /invoke automatically/i }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({
    trigger: { type: 'sqs', queueName: 'new-queue', enabled: true },
  }))
})

it('clears the trigger when the queue name is left blank', async () => {
  render(<SettingsDialog fn={{ ...fn, trigger: { type: 'sqs', queueName: 'my-queue', enabled: true } }} />,
    { wrapper: makeWrapper() })
  const user = await openSettings()
  await user.clear(screen.getByLabelText('SQS trigger queue'))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.updateFunction).toHaveBeenCalledWith('fn1', expect.objectContaining({ trigger: null }))
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm --prefix web run test -- settings-dialog.test.tsx`
Expected: FAIL — no "SQS trigger queue" field exists yet.

- [ ] **Step 3: Implement in `web/src/components/settings-dialog.tsx`**

Add the import:

```ts
import { Checkbox } from '@/components/ui/checkbox'
```

Add state (after `buildCommand`):

```ts
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.queueName ?? '')
  const [triggerEnabled, setTriggerEnabled] = useState(fn.trigger?.enabled ?? false)
```

In the reseed `useEffect`, add:

```ts
    setTriggerQueueName(fn.trigger?.queueName ?? '')
    setTriggerEnabled(fn.trigger?.enabled ?? false)
```

In `save()`, add `trigger` to the patch object:

```ts
          buildCommand: buildCommand.trim(),
          trigger: triggerQueueName.trim()
            ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled: triggerEnabled }
            : null,
```

Add the section in the JSX (after the "Build command" `grid gap-2` block, before `</div>` that closes the outer `grid gap-4`):

```tsx
          <div className="grid gap-2">
            <Label htmlFor="s-trigger-queue">SQS trigger queue</Label>
            <Input id="s-trigger-queue" value={triggerQueueName}
              onChange={(e) => setTriggerQueueName(e.target.value)}
              spellCheck={false} placeholder="queue name (empty = no trigger)" />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={triggerEnabled} disabled={!triggerQueueName.trim()}
                onCheckedChange={(v) => setTriggerEnabled(v === true)} />
              Invoke automatically when a message arrives
            </label>
            <p className="text-xs text-muted-foreground">
              Auto-starts the local SQS service (ElasticMQ) and creates the queue if it doesn't exist.
            </p>
          </div>
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `npm --prefix web run test -- settings-dialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings-dialog.tsx web/src/components/settings-dialog.test.tsx
git commit -m "feat(web): configure an SQS trigger from the function settings dialog"
```

---

### Task 12: Trigger status badge in the function header

**Files:**
- Create: `web/src/components/trigger-status-badge.tsx`
- Test: `web/src/components/trigger-status-badge.test.tsx`
- Modify: `web/src/components/function-header.tsx`

**Interfaces:**
- Consumes: `TriggerStatus` (Task 10), `useTriggerStatus` (Task 10), `Badge` (existing).
- Produces: `TriggerStatusBadge({ status }: { status: TriggerStatus })`.

- [ ] **Step 1: Write the failing test — `web/src/components/trigger-status-badge.test.tsx`** (new file)

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TriggerStatusBadge } from '@/components/trigger-status-badge'

it('shows the polling state', () => {
  render(<TriggerStatusBadge status={{ state: 'polling', lastError: null, lastPolledAt: 123 }} />)
  expect(screen.getByText('Trigger: polling')).toBeInTheDocument()
})

it('shows the error state with the message in a title attribute', () => {
  render(<TriggerStatusBadge status={{ state: 'error', lastError: 'connection refused', lastPolledAt: null }} />)
  const badge = screen.getByText('Trigger: error')
  expect(badge).toHaveAttribute('title', 'connection refused')
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm --prefix web run test -- trigger-status-badge.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `web/src/components/trigger-status-badge.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { TriggerStatus } from '@/lib/types'

const STATE_LABEL: Record<TriggerStatus['state'], string> = {
  idle: 'Trigger: idle',
  polling: 'Trigger: polling',
  error: 'Trigger: error',
}

const STATE_CLASS: Record<TriggerStatus['state'], string> = {
  idle: 'border-transparent bg-muted text-muted-foreground',
  polling: 'border-transparent bg-success/15 text-success',
  error: 'border-transparent bg-destructive/15 text-destructive',
}

export function TriggerStatusBadge({ status }: { status: TriggerStatus }) {
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', STATE_CLASS[status.state])}
      title={status.lastError ?? undefined}>
      {STATE_LABEL[status.state]}
    </Badge>
  )
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `npm --prefix web run test -- trigger-status-badge.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire into `web/src/components/function-header.tsx`**

Add imports:

```ts
import { TriggerStatusBadge } from '@/components/trigger-status-badge'
import { useDeleteFunction, useTriggerStatus } from '@/lib/queries'
```

(replacing the existing `import { useDeleteFunction } from '@/lib/queries'` line)

Inside the component, add after `const del = useDeleteFunction()`:

```ts
  const { data: triggerStatuses } = useTriggerStatus()
  const triggerStatus = fn.trigger?.enabled ? triggerStatuses?.[fn.id] : undefined
```

Add the badge in the JSX, right after the existing runtime `<Badge>`:

```tsx
      <Badge variant="secondary" className="font-mono">{fn.runtime}</Badge>
      {triggerStatus && <TriggerStatusBadge status={triggerStatus} />}
```

- [ ] **Step 6: Run the full web test suite**

Run: `npm run test:web`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/components/trigger-status-badge.tsx web/src/components/trigger-status-badge.test.tsx \
  web/src/components/function-header.tsx
git commit -m "feat(web): show live trigger poll status in the function header"
```

---

### Task 13: History trigger badge

**Files:**
- Modify: `web/src/components/history-list.tsx`
- Test: `web/src/components/history-list.test.tsx`

**Interfaces:**
- Consumes: `HistoryEntry.source` (Task 10).

- [ ] **Step 1: Write the failing test — `web/src/components/history-list.test.tsx`** (new file)

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { listHistory: vi.fn(), clearHistory: vi.fn() },
}))

import { HistoryList } from '@/components/history-list'
import { api } from '@/lib/api'
import type { HistoryEntry } from '@/lib/types'

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'e1', ts: Date.now(), handler: 'app.handler', source: { type: 'manual' },
    event: {}, eventTruncated: false, response: {}, responseTruncated: false,
    error: null, logs: '', report: null, durationMs: 5, ok: true, truncated: false,
    ...overrides,
  }
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => vi.clearAllMocks())

it('badges a trigger-sourced run but not a manual one', async () => {
  vi.mocked(api.listHistory).mockResolvedValue({
    entries: [
      entry({ id: 'manual1', source: { type: 'manual' } }),
      entry({ id: 'trig1', source: { type: 'trigger', messageId: 'm1' } }),
    ],
  })
  render(<HistoryList fnId="fn1" onLoadEvent={() => {}} />, { wrapper: makeWrapper() })

  const rows = await screen.findAllByRole('button')
  expect(within(rows[0]).queryByText('trigger')).not.toBeInTheDocument()
  expect(within(rows[1]).getByText('trigger')).toBeInTheDocument()
})
```

Add the `within` import to the `@testing-library/react` import line:

```tsx
import { render, screen, within } from '@testing-library/react'
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm --prefix web run test -- history-list.test.tsx`
Expected: FAIL — no "trigger" text is rendered.

- [ ] **Step 3: Implement in `web/src/components/history-list.tsx`**

In the list row (inside the `<button>`, after the `{e.ok && <HttpStatusBadge .../>}` line and before `<span className="truncate font-mono">{e.handler}</span>`):

```tsx
                {e.source?.type === 'trigger' && (
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px]">trigger</Badge>
                )}
```

In the detail header (after `{openEntry.ok && <HttpStatusBadge response={openEntry.response} />}`):

```tsx
          {openEntry.source?.type === 'trigger' && (
            <Badge variant="outline" className="font-mono text-[10px]">trigger</Badge>
          )}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `npm --prefix web run test -- history-list.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full web test suite**

Run: `npm run test:web`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/history-list.tsx web/src/components/history-list.test.tsx
git commit -m "feat(web): badge trigger-sourced runs in the History tab"
```

---

### Task 14: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a paragraph** to the "Calling AWS services" section, right after the existing `fixtures/typescript/node-s3` paragraph:

```markdown
A function can also be invoked automatically instead of manually: open its
Settings, set an SQS queue name under "SQS trigger queue", and enable it.
The playground auto-starts ElasticMQ, creates the queue if it doesn't
exist, and invokes the function for every message that arrives (one
message per invoke, deleted after every invoke whether it succeeds or
fails — no batching or redelivery in this first cut). Trigger-caused runs
are tagged in the History tab so you can tell them apart from manual
invokes. Enabling a trigger is saved with the function, so it resumes
automatically the next time you start the playground.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the SQS trigger feature"
```

---

## Final Verification

After all tasks:

- [ ] `npm run test:server` — PASS (includes `tests/trigger-docker.test.js`, real-docker skip-aware)
- [ ] `npm run test:web` — PASS
- [ ] `npm run lint` — PASS
- [ ] `npm run build` — rebuilds `web/dist` with the new UI
- [ ] Manual smoke test per Task 8 Step 3
