const { test } = require('node:test');
const assert = require('node:assert');
const { runLoop, start, POLL_IDLE_MS, ERROR_BACKOFF_MS } = require('../../server/trigger/poller');
const inFlight = require('../../server/api/in-flight');

// Generic batch shape used by these tests: { id, receiptHandle }. buildEvent
// and buildSource stand in for what sqs.js/dynamodb.js actually build.
const buildEvent = (batch) => ({ Records: [batch] });
const buildSource = (batch) => ({ type: 'trigger', id: batch.id });

test('idle and error backoff default to a couple of seconds', () => {
  assert.strictEqual(POLL_IDLE_MS, 2000);
  assert.strictEqual(ERROR_BACKOFF_MS, 2000);
});

test('runLoop invokes the function for a received batch and acks it', async () => {
  const controller = new AbortController();
  const calls = { invoke: [], ack: [] };
  const receive = async () => ({ id: 'm1', receiptHandle: 'rh1' });
  const ack = async (batch) => { calls.ack.push(batch.receiptHandle); controller.abort(); };
  const invokeFunction = async (input) => { calls.invoke.push(input); return { status: 200 }; };

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal,
    receive, ack, buildEvent, buildSource, invokeFunction,
  });

  assert.strictEqual(calls.invoke.length, 1);
  assert.strictEqual(calls.invoke[0].functionId, 'fn1');
  assert.deepStrictEqual(calls.invoke[0].source, { type: 'trigger', id: 'm1' });
  assert.strictEqual(calls.invoke[0].event.Records[0].id, 'm1');
  assert.deepStrictEqual(calls.ack, ['rh1']);
});

test('runLoop acks even when the invoke fails', async () => {
  const controller = new AbortController();
  const acked = [];
  const receive = async () => ({ id: 'm1', receiptHandle: 'rh1' });
  const ack = async (batch) => { acked.push(batch.receiptHandle); controller.abort(); };
  // A handler error still comes back as status 200 (the failure lives in the
  // body) — only guard responses like 409/404 are non-200, and those are
  // covered by the dedicated test below.
  const invokeFunction = async () => ({ status: 200, body: { ok: false, error: { message: 'boom' } } });

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, ack, buildEvent, buildSource, invokeFunction,
  });

  assert.deepStrictEqual(acked, ['rh1']);
});

test('runLoop acks even when invokeFunction throws', async () => {
  const controller = new AbortController();
  const acked = [];
  const statuses = [];
  const receive = async () => ({ id: 'm1', receiptHandle: 'rh1' });
  const ack = async (batch) => { acked.push(batch.receiptHandle); controller.abort(); };
  const invokeFunction = async () => { throw new Error('invoke crashed'); };

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, ack, buildEvent, buildSource, invokeFunction,
    onStatus: (s) => statuses.push(s),
  });

  assert.deepStrictEqual(acked, ['rh1']);
  assert.ok(statuses.some((s) => s.state === 'error' && s.lastError === 'invoke failed: invoke crashed'));
});

test('runLoop leaves the batch un-acked when invokeFunction returns a 409 guard response', async () => {
  const controller = new AbortController();
  const acked = [];
  let receiveCalls = 0;
  const receive = async () => {
    receiveCalls++;
    if (receiveCalls > 1) { controller.abort(); return null; }
    return { id: 'm1', receiptHandle: 'rh1' };
  };
  const ack = async (batch) => { acked.push(batch.receiptHandle); };
  const invokeFunction = async () => ({ status: 409, body: { error: 'in flight' } });

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, ack, buildEvent, buildSource, invokeFunction,
  });

  assert.deepStrictEqual(acked, []);
});

test('runLoop with no ack still moves on to the next poll after a failed invoke', async () => {
  const controller = new AbortController();
  let polls = 0;
  const receive = async () => {
    polls++;
    if (polls === 1) return { id: 'm1' };
    controller.abort();
    return null;
  };
  const invokeFunction = async () => ({ status: 500 });
  const sleep = async () => {};

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource, invokeFunction, sleep,
  });

  assert.strictEqual(polls, 2);
});

test('runLoop does not sleep on an empty batch by default (relies on receive()\'s own wait)', async () => {
  const controller = new AbortController();
  let receiveCalls = 0;
  const receive = async () => {
    receiveCalls++;
    if (receiveCalls > 1) controller.abort();
    return null;
  };
  let slept = false;
  const sleep = async () => { slept = true; };

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }), sleep,
  });

  assert.strictEqual(slept, false);
  assert.ok(receiveCalls >= 2);
});

test('runLoop sleeps on an empty batch when sleepOnEmpty is true', async () => {
  const controller = new AbortController();
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return null; };
  const sleep = async () => { controller.abort(); };

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }), sleep, sleepOnEmpty: true,
  });

  assert.strictEqual(receiveCalls, 1);
});

test('runLoop skips a poll cycle while the function is already in flight', async () => {
  const controller = new AbortController();
  inFlight.add('fn1');
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return null; };
  const statuses = [];
  const sleep = async () => { inFlight.delete('fn1'); controller.abort(); };

  await runLoop({
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }), onStatus: (s) => statuses.push(s), sleep,
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
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }), onStatus: (s) => statuses.push(s), sleep,
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
    fn: { id: 'fn1' }, signal: controller.signal, receive, buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }), onStatus: (s) => statuses.push(s),
  });

  assert.ok(!statuses.some((s) => s.state === 'error'));
});

test('start runs setup then the loop, invoking and acking a received batch', async () => {
  const statuses = [];
  let acked = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const handle = start({ id: 'fn1' }, {
    onStatus: (s) => statuses.push(s),
    setup: async () => ({
      receive: async () => ({ id: 'm1' }),
      // Stops the loop itself (via the closed-over `handle`) after the first
      // batch, rather than racing a real timer against a tight async loop.
      ack: async (batch) => { acked = batch.id; handle.stop(); resolveDone(); },
    }),
    buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }),
  });
  await done;

  assert.strictEqual(acked, 'm1');
  assert.ok(statuses.some((s) => s.state === 'polling'));
});

test('start reports a setup failure as an error status rather than throwing', async () => {
  const statuses = [];
  start({ id: 'fn1' }, {
    onStatus: (s) => statuses.push(s),
    setup: async () => { throw new Error('boom'); },
    buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }),
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(statuses.some((s) => s.state === 'error' && s.lastError === 'boom'));
});

test('start does not report an error status once stopped before setup resolves', async () => {
  const statuses = [];
  let resolveSetup;
  const handle = start({ id: 'fn1' }, {
    onStatus: (s) => statuses.push(s),
    setup: () => new Promise((resolve, reject) => { resolveSetup = reject; }),
    buildEvent, buildSource,
    invokeFunction: async () => ({ status: 200 }),
  });
  handle.stop();
  resolveSetup(new Error('setup aborted'));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(!statuses.some((s) => s.state === 'error'));
});
