# Warm Execution Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse a handler's process across invokes the way real Lambda reuses an execution environment — module-scope state, `/tmp` contents and connection pools persisting, and `initMs` reported only on the cold invoke — so the "works once, fails the second time" class of bug becomes reproducible locally.

**Architecture:** Each harness gains a request loop. The parent writes length-prefixed JSON requests to the child's stdin and reads each result from a per-request file, exactly as it does today for a single invoke; a NUL-delimited sentinel on stdout marks the end of one invoke's logs and signals that the result file is ready. `server/runtime/pool.js` keys a live child process by everything that would change its behaviour and evicts it on idle, config change, source change, timeout, crash or build.

**Tech Stack:** Node.js ≥22.12 (CommonJS server), `node:test`, the four existing harnesses (Node ESM, Python 3, Java 11, and the `provided` Runtime API emulator), React 19 + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-31-architecture-overhaul-design.md`

**Predecessors:** `2026-08-31-foundations-and-contracts.md` (complete), `2026-08-31-structure-and-packaging.md` (complete at `b55ed40`)

## Deviation from the spec — read this first

The spec specifies **a shared loopback control server**, with each harness connecting and identifying itself by `envId`, because a JVM cannot portably reach an inherited fd 3.

**This plan does not build that.** A third channel exists that the spec overlooked: the parent already writes the event to the child's **stdin**, and the child already writes its envelope to a **result file**. Both generalise to a loop with no new transport:

```
parent → child stdin:   <byte length>\n<request JSON>
child  → result file:   the same envelope shape it writes today
child  → child stdout:  \0AWSPLAY-END:<requestId>\0   (after flushing)
parent:                 cut logs at the sentinel, read the result file
```

This is strictly simpler and better:

- **No control server, port, handshake or `envId` correlation** — an entire subsystem deleted. This project already has port pressure (9400–9404, 9500–9501, the OTLP receiver).
- **Identical in all four runtimes.** Every one of them can already read stdin and write a file; that is exactly what they do today. The fd-3 problem that motivated sockets does not arise.
- **The sentinel was needed anyway.** Logs stream on stdout while the response arrives out-of-band, so *some* in-band marker is required to know which log bytes belong to which invoke. Once it exists, it also serves as "the result file is written" — so the socket carried no information the sentinel did not already have to carry.
- **Smaller diff per harness.** Each keeps its existing envelope-writing code and gains a loop around it, rather than gaining a socket client.

Everything else in the spec — the pool key, warm-by-default, eviction rules, the `fs.watch` staleness deviation, the cold/warm badge, force-cold — is implemented as written.

## Global Constraints

- **The server stays dependency-free.** No new runtime dependencies.
- **Node ≥ 22.12**; Python 3; Java 11 (`--release 11` in `harnesses/java/build.sh`).
- **Comments explain *why*, never *what*.**
- **Conventional commits**, each ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Backwards compatibility is not required at the harness boundary.** The harnesses ship with the server; they are versioned together. Do not build a v1/v2 negotiation.
- **A warm environment must never serve stale code.** Every eviction rule in Task 6 is load-bearing. If a rule cannot be implemented on a platform, the environment must be evicted after *every* invoke there — degrading to today's always-cold behaviour, which is slower but never wrong.
- **The gate:**
  ```bash
  npm run test:unit && npm run test:integration && npm run typecheck:server
  ```
  `tests/integration/trigger-docker.test.js` is broken before this work starts (2 failures + a file timeout, proven pre-existing). Ignore those three; any *other* integration failure is yours.

---

## Task 1: The wire protocol

**Files:**
- Create: `server/runtime/protocol.js`
- Test: `tests/unit/protocol.test.js`

**Interfaces:**
- Produces:
  - `SENTINEL_PREFIX = '\0AWSPLAY-END:'`, `SENTINEL_SUFFIX = '\0'`
  - `encodeRequest(obj) -> string` — `<byteLength>\n<json>`
  - `sentinelFor(requestId) -> string`
  - `splitAtSentinel(buffer, requestId) -> { logs, rest } | null` — `null` until the sentinel has fully arrived.

**Context:** The parent and all four harnesses have to agree on framing. Putting it in one module means the JS side is tested directly, and the Python/Java/`provided` sides have exactly one specification to mirror.

Length-prefixing the request rather than newline-delimiting it matters: an event JSON containing a literal newline inside a string is legal and common (a multi-line body), so a newline-delimited reader would split a request in half.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/protocol.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  encodeRequest, sentinelFor, splitAtSentinel, SENTINEL_PREFIX,
} = require('../../server/runtime/protocol');

test('encodeRequest length-prefixes the payload in bytes, not characters', () => {
  const encoded = encodeRequest({ hello: 'wörld' });
  const [header, ...rest] = encoded.split('\n');
  const body = rest.join('\n');
  assert.strictEqual(Number(header), Buffer.byteLength(body, 'utf8'));
  assert.deepStrictEqual(JSON.parse(body), { hello: 'wörld' });
});

test('encodeRequest survives a newline inside the payload', () => {
  const encoded = encodeRequest({ body: 'line one\nline two' });
  const nl = encoded.indexOf('\n');
  const body = encoded.slice(nl + 1);
  assert.deepStrictEqual(JSON.parse(body), { body: 'line one\nline two' });
});

test('splitAtSentinel returns null until the whole sentinel has arrived', () => {
  const id = 'abc';
  assert.strictEqual(splitAtSentinel('partial logs', id), null);
  assert.strictEqual(splitAtSentinel('logs' + SENTINEL_PREFIX + 'ab', id), null);
});

test('splitAtSentinel cuts the logs and keeps what follows', () => {
  const id = 'abc';
  const buf = 'hello from the handler\n' + sentinelFor(id) + 'next invoke output';
  assert.deepStrictEqual(splitAtSentinel(buf, id),
    { logs: 'hello from the handler\n', rest: 'next invoke output' });
});

test('splitAtSentinel ignores a sentinel for a different request', () => {
  assert.strictEqual(splitAtSentinel('logs' + sentinelFor('other'), 'abc'), null);
});

test('handler output that merely mentions the marker does not split it early', () => {
  const id = 'abc';
  const buf = 'the marker is AWSPLAY-END:abc apparently\n' + sentinelFor(id);
  const { logs } = splitAtSentinel(buf, id);
  assert.match(logs, /apparently/, 'cut at the plain-text mention instead of the NUL-framed one');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/protocol.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/runtime/protocol.js`**

```js
// The framing the parent and all four harnesses agree on.
//
// Requests are length-prefixed rather than newline-delimited because an event
// JSON may legally contain a literal newline inside a string; a line reader
// would split such a request in half.
//
// Responses come back through the per-request result file, exactly as they did
// when every invoke got its own process. What the sentinel adds is ordering:
// logs stream on stdout while the envelope lands out-of-band, so without an
// in-band marker the parent cannot know which log bytes belong to this invoke,
// or when the file is safe to read. NUL framing plus the request's UUID keeps
// it from colliding with handler output that happens to mention the marker.
const SENTINEL_PREFIX = '\0AWSPLAY-END:';
const SENTINEL_SUFFIX = '\0';

function encodeRequest(obj) {
  const json = JSON.stringify(obj);
  return `${Buffer.byteLength(json, 'utf8')}\n${json}`;
}

function sentinelFor(requestId) {
  return `${SENTINEL_PREFIX}${requestId}${SENTINEL_SUFFIX}`;
}

// null means "not yet" -- the caller keeps accumulating. Returning the
// remainder rather than discarding it matters for a handler that writes
// asynchronously after returning: that output belongs to the next invoke's
// logs, which is what real Lambda does with it too.
function splitAtSentinel(buffer, requestId) {
  const marker = sentinelFor(requestId);
  const at = buffer.indexOf(marker);
  if (at === -1) return null;
  return { logs: buffer.slice(0, at), rest: buffer.slice(at + marker.length) };
}

module.exports = {
  SENTINEL_PREFIX, SENTINEL_SUFFIX, encodeRequest, sentinelFor, splitAtSentinel,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/protocol.test.js`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add server/runtime/protocol.js tests/unit/protocol.test.js
git commit -m "$(cat <<'EOF'
feat(runtime): add the warm-invoke wire protocol

Length-prefixed requests on stdin, results in the per-request file, and a
NUL-framed sentinel on stdout marking where one invoke's logs end.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Teach the Node harness to loop

**Files:**
- Modify: `harnesses/node/harness.mjs`
- Test: `tests/integration/harness-node.test.js` (add warm cases)

**Interfaces:**
- Consumes: the framing from Task 1, mirrored in JS.
- Produces: a harness that, given `--warm`, serves requests until stdin closes. Without `--warm` it behaves exactly as today, so nothing depends on the pool landing first.

**Context:** Today the harness reads one event from stdin, writes the envelope, and calls `process.exit(0)`. The loop keeps module scope, `/tmp` and any connection pools alive between invokes — which is the entire point.

Handler resolution stays where it is: it happens once, before the loop, and its cost is the `initMs` reported on the first response only.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/harness-node.test.js`:

```js
const { encodeRequest, sentinelFor } = require('../../server/runtime/protocol');

// Spawns the harness in warm mode and drives N invokes through one process.
async function warmInvokes(dir, handler, events) {
  const { spawn } = require('node:child_process');
  const results = [];
  const child = spawn(process.execPath, [HARNESS, '--handler', handler, '--warm'], { cwd: dir });
  let buf = '';
  const logsFor = [];
  try {
    for (const event of events) {
      const requestId = require('node:crypto').randomUUID();
      const resultFile = path.join(os.tmpdir(), `awsplay-test-${requestId}.json`);
      child.stdin.write(encodeRequest({ requestId, resultFile, event, timeoutMs: 5000, memoryMb: 128 }));
      const marker = sentinelFor(requestId);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no sentinel; buffer: ${JSON.stringify(buf)}`)), 10000);
        const onData = (d) => {
          buf += d;
          if (buf.includes(marker)) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            const at = buf.indexOf(marker);
            logsFor.push(buf.slice(0, at));
            buf = buf.slice(at + marker.length);
            resolve();
          }
        };
        child.stdout.on('data', onData);
      });
      results.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      fs.unlinkSync(resultFile);
    }
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
  }
  return { results, logs: logsFor };
}

test('a warm harness keeps module scope across invokes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-warm-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    'let calls = 0;\nexport const handler = async () => ({ calls: ++calls });\n');

  const { results } = await warmInvokes(dir, 'index.handler', [{}, {}, {}]);
  assert.deepStrictEqual(results.map((r) => r.response), [
    { calls: 1 }, { calls: 2 }, { calls: 3 },
  ], 'module scope was not reused — each invoke got a fresh module');
});

test('only the first warm invoke reports initMs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-warm2-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = async () => ({ ok: true });\n');

  const { results } = await warmInvokes(dir, 'index.handler', [{}, {}]);
  assert.ok(typeof results[0].initMs === 'number', 'the cold invoke should report initMs');
  assert.strictEqual(results[1].initMs, undefined, 'a warm invoke must not report initMs');
});

test('each warm invoke gets only its own logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-warm3-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    'export const handler = async (e) => { console.log("run:" + e.n); return { n: e.n }; };\n');

  const { logs } = await warmInvokes(dir, 'index.handler', [{ n: 1 }, { n: 2 }]);
  assert.match(logs[0], /run:1/);
  assert.doesNotMatch(logs[0], /run:2/);
  assert.match(logs[1], /run:2/);
  assert.doesNotMatch(logs[1], /run:1/, "the second invoke's logs still carried the first's output");
});

test('a handler error does not kill the warm environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-warm4-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    'export const handler = async (e) => { if (e.boom) throw new Error("nope"); return { ok: true }; };\n');

  const { results } = await warmInvokes(dir, 'index.handler', [{ boom: true }, {}]);
  assert.strictEqual(results[0].ok, false);
  assert.strictEqual(results[0].error.message, 'nope');
  assert.strictEqual(results[1].ok, true, 'the environment died after a handler error');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/harness-node.test.js`
Expected: FAIL — the harness ignores `--warm` and exits after one invoke.

- [ ] **Step 3: Restructure the harness**

Keep everything above handler resolution as-is. Then:

1. Read `--warm` via the existing `arg()` helper.
2. Move handler resolution into a `resolveHandler()` that runs once and returns either the function or an init-error envelope. Measure `initMs` around it.
3. Extract the existing invoke body into `async function runOne({ requestId, resultFile, event, timeoutMs, memoryMb, initMs })`, unchanged except that it takes those as parameters and **does not** call `process.exit`.
4. In cold mode (`--warm` absent) call `runOne` once with the CLI args and exit — byte-for-byte today's behaviour.
5. In warm mode, loop:

```js
// A length-prefixed reader, not a line reader: an event JSON may contain a
// literal newline inside a string, which would split a request in half.
async function* requests(stream) {
  let buf = Buffer.alloc(0);
  let need = null;
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (need === null) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        need = parseInt(buf.subarray(0, nl).toString('utf8'), 10);
        buf = buf.subarray(nl + 1);
      }
      if (buf.length < need) break;
      const json = buf.subarray(0, need).toString('utf8');
      buf = buf.subarray(need);
      need = null;
      yield JSON.parse(json);
    }
  }
}

for await (const req of requests(process.stdin)) {
  await runOne({ ...req, initMs: firstInvoke ? initMs : undefined });
  firstInvoke = false;
  // Flush before the sentinel so the parent, which cuts this invoke's logs
  // at the marker, cannot miss output written just before it.
  await flushStdio();
  process.stdout.write(`\0AWSPLAY-END:${req.requestId}\0`);
}
process.exit(0);
```

`flushStdio` must actually wait, not assume:

```js
function flushStdio() {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending === 0) resolve(); };
    // write('') resolves once everything queued ahead of it has drained.
    process.stdout.write('', done);
    process.stderr.write('', done);
  });
}
```

Keep the existing `__awsPlaygroundFlushTracing` call inside `runOne` — auto-tracing must still flush per invoke.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/harness-node.test.js`
Expected: PASS, including every pre-existing cold-mode test. **If a cold test fails, the refactor changed single-invoke behaviour — fix that before continuing.**

- [ ] **Step 5: Commit**

```bash
git add harnesses/node/harness.mjs tests/integration/harness-node.test.js
git commit -m "$(cat <<'EOF'
feat(harness): let the Node harness serve invokes in a loop

--warm keeps module scope, /tmp and connection pools alive across
invokes, and reports initMs only on the first. Without the flag the
harness behaves exactly as before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The environment pool

**Files:**
- Create: `server/runtime/pool.js`
- Test: `tests/unit/pool.test.js`

**Interfaces:**
- Produces:
  - `keyFor(opts) -> string` — sha256 over `id, runtime, dir, handler, memoryMb, jarPath, autoTrace` and the sorted `env` pairs. **`timeoutMs` is excluded**: it is enforced by the parent, not baked into the child.
  - `acquire(opts) -> Promise<Env>` where `Env` is `{ key, send(request) -> Promise<{logs, envelope}>, dispose(), cold }`
  - `evict(key)`, `evictForFunction(functionId)`, `shutdown()`
  - `size()` — for tests.
- Consumed by Task 4 (`invoker.js`) and Task 8 (`bootstrap.js`).

**Context:** The pool is an explicit, injectable object rather than ambient module state, so tests opt out of warm behaviour deliberately instead of discovering it by accident.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pool.test.js`. Drive a **fake harness** — a tiny script speaking the protocol — so the pool is tested without any real runtime:

```js
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../server/runtime/pool');

const FAKE = path.join(os.tmpdir(), 'awsplay-fake-harness.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
let calls = 0;
let buf = Buffer.alloc(0); let need = null;
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (need === null) {
      const nl = buf.indexOf(0x0a); if (nl === -1) return;
      need = parseInt(buf.subarray(0, nl).toString(), 10); buf = buf.subarray(nl + 1);
    }
    if (buf.length < need) return;
    const req = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = null;
    calls++;
    console.log('log for ' + req.event.n);
    fs.writeFileSync(req.resultFile, JSON.stringify({
      ok: true, phase: 'invoke', response: { calls }, durationMs: 1,
      ...(calls === 1 ? { initMs: 5 } : {}),
    }));
    process.stdout.write('\\0AWSPLAY-END:' + req.requestId + '\\0');
  }
});
`);

function opts(over = {}) {
  return {
    id: 'fn1', runtime: 'node', dir: os.tmpdir(), handler: 'index.handler',
    env: {}, memoryMb: 128, jarPath: null, autoTrace: false,
    command: { cmd: process.execPath, args: [FAKE] },
    ...over,
  };
}

afterEach(async () => { await pool.shutdown(); });

test('a second invoke reuses the same process', async () => {
  const a = await pool.acquire(opts());
  const first = await a.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(first.envelope.response.calls, 1);
  assert.strictEqual(a.cold, true);

  const b = await pool.acquire(opts());
  const second = await b.send({ event: { n: 2 }, timeoutMs: 5000 });
  assert.strictEqual(second.envelope.response.calls, 2, 'a fresh process was started');
  assert.strictEqual(b.cold, false);
  assert.strictEqual(pool.size(), 1);
});

test('each invoke gets only its own logs', async () => {
  const a = await pool.acquire(opts());
  const first = await a.send({ event: { n: 1 }, timeoutMs: 5000 });
  const second = await (await pool.acquire(opts())).send({ event: { n: 2 }, timeoutMs: 5000 });
  assert.match(first.logs, /log for 1/);
  assert.doesNotMatch(first.logs, /log for 2/);
  assert.match(second.logs, /log for 2/);
  assert.doesNotMatch(second.logs, /log for 1/);
});

test('a changed env value is a different environment', async () => {
  await (await pool.acquire(opts())).send({ event: { n: 1 }, timeoutMs: 5000 });
  const changed = await pool.acquire(opts({ env: { A: '1' } }));
  assert.strictEqual(changed.cold, true, 'an env change reused the old environment');
  assert.strictEqual(pool.size(), 2);
});

test('timeoutMs is not part of the key — it is enforced by the parent', () => {
  assert.strictEqual(pool.keyFor(opts()), pool.keyFor(opts({ timeoutMs: 999 })));
});

test('handler, memory, jar and autoTrace all change the key', () => {
  const base = pool.keyFor(opts());
  for (const over of [{ handler: 'other.handler' }, { memoryMb: 512 },
    { jarPath: '/x.jar' }, { autoTrace: true }, { dir: '/elsewhere' }]) {
    assert.notStrictEqual(pool.keyFor(opts(over)), base, `${JSON.stringify(over)} did not change the key`);
  }
});

test('evictForFunction drops every environment for that function', async () => {
  await (await pool.acquire(opts())).send({ event: { n: 1 }, timeoutMs: 5000 });
  await (await pool.acquire(opts({ env: { A: '1' } }))).send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 2);
  pool.evictForFunction('fn1');
  assert.strictEqual(pool.size(), 0);
});

test('a timed-out invoke destroys the environment', async () => {
  const hang = path.join(os.tmpdir(), 'awsplay-hang-harness.mjs');
  fs.writeFileSync(hang, 'process.stdin.on("data", () => {});\n');
  const env = await pool.acquire(opts({ command: { cmd: process.execPath, args: [hang] } }));
  await assert.rejects(() => env.send({ event: {}, timeoutMs: 200 }), /timed out/i);
  assert.strictEqual(pool.size(), 0, 'a timed-out environment must not be reused');
});

test('a crashed child is evicted rather than handed out again', async () => {
  const crash = path.join(os.tmpdir(), 'awsplay-crash-harness.mjs');
  fs.writeFileSync(crash, 'process.stdin.on("data", () => process.exit(3));\n');
  const env = await pool.acquire(opts({ command: { cmd: process.execPath, args: [crash] } }));
  await assert.rejects(() => env.send({ event: {}, timeoutMs: 5000 }));
  assert.strictEqual(pool.size(), 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/pool.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/runtime/pool.js`**

Implement to that contract. The load-bearing points:

- **One in-flight request per environment.** The `inFlight` guard already ensures this per function; assert it rather than trusting it, because the log sentinel cannot disambiguate interleaved output. Reject a concurrent `send` on the same environment with a clear error.
- **`send` resolves `{ logs, envelope }`.** Accumulate stdout+stderr into one buffer, and on each chunk try `splitAtSentinel(buf, requestId)`. On a hit, the logs are the prefix, `buf` becomes `rest`, and the result file is read and unlinked.
- **Timeout is the parent's job.** `setTimeout(timeoutMs)` around the send; on fire, kill the process group (`process.kill(-pid, 'SIGKILL')`, `child.kill` on Windows), evict, and reject with the same `Sandbox.Timedout` message the invoker produces today.
- **`close`/`error` on the child rejects any pending send and evicts.**
- **Idle eviction** via `AWS_PLAYGROUND_WARM_IDLE_MS` (default 300000), following `services/lifecycle.js`'s `graceMs()` pattern. `unref()` the timer so it never keeps the process alive.
- **`spawn` with `detached: process.platform !== 'win32'`**, matching the invoker, so the timeout can kill a whole process group.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/pool.test.js`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add server/runtime/pool.js tests/unit/pool.test.js
git commit -m "$(cat <<'EOF'
feat(runtime): add the warm execution environment pool

Keyed by everything that would change handler behaviour; timeoutMs is
excluded because the parent enforces it. Evicts on config change,
timeout, crash and idle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Evict on source change

**Files:**
- Modify: `server/runtime/pool.js`
- Test: `tests/unit/pool.test.js`

**Context:** This is the deliberate break from Lambda in the spec. Real Lambda has no notion of code changing under a warm environment; locally the source changes constantly, and an environment holding the previous version makes the tool actively wrong.

**The failure mode of this subsystem must be "no faster than before", never "ran your old code".**

- [ ] **Step 1: Write the failing test**

```js
test('editing a file in the project directory evicts the environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-watch-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = () => 1;\n');
  const env = await pool.acquire(opts({ dir }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 1);

  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = () => 2;\n');
  await new Promise((r) => setTimeout(r, 300));   // debounce + watch latency
  assert.strictEqual(pool.size(), 0, 'a source edit did not evict the environment');
});

test('node_modules churn does not evict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-watch2-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const env = await pool.acquire(opts({ dir }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });

  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'noise');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(pool.size(), 1, 'a node_modules write should not cost a cold start');
});

test('an environment whose directory cannot be watched is evicted after every invoke', async () => {
  const env = await pool.acquire(opts({ watch: false }));
  await env.send({ event: { n: 1 }, timeoutMs: 5000 });
  assert.strictEqual(pool.size(), 0,
    'without a watch the only safe behaviour is always-cold');
});
```

- [ ] **Step 2: Implement**

On `acquire`, start `fs.watch(dir, { recursive: true })`, debounced ~150ms, ignoring any path containing `node_modules` or starting with `.`. On an event, `evict(key)`.

Wrap the `fs.watch` call in `try/catch`. On failure — or when `opts.watch === false` — mark the environment `unwatchable` and evict it in `send`'s `finally`. Log once per environment, not per invoke:

```js
console.warn(`aws-playground: cannot watch ${dir} for changes (${err.message}); `
  + 'this function will cold start every invoke so it never runs stale code.');
```

Close the watcher in `dispose()` — a leaked recursive watcher is a real descriptor leak.

- [ ] **Step 3: Run the gate, then commit**

```bash
node --test tests/unit/pool.test.js
git add server/runtime/pool.js tests/unit/pool.test.js
git commit -m "$(cat <<'EOF'
feat(runtime): evict a warm environment when its source changes

The one deliberate break from Lambda: locally the code changes under a
warm environment constantly, and serving the previous version would make
the tool wrong. A directory that cannot be watched degrades to
always-cold rather than to possibly-stale.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Route invokes through the pool

**Files:**
- Modify: `server/runtime/invoker.js`, `server/api/invoke.js`, `server/schema/function.js`
- Test: `tests/unit/invoker.test.js`, `tests/unit/api.test.js`

**Interfaces:**
- Produces: `invoke(opts)` gains `forceCold`. `report.cold` (boolean) is added to every invoke result. `InvokeOutcome` in `server/types.d.ts` gains it.

**Context:** `invoker.js` currently builds `command`, `env` and `harnessArgs`, spawns, and reads the result file. The pool takes over the spawn-and-read half; everything about *what* to spawn stays where it is.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/invoker.test.js`:

```js
test('a second invoke of the same function is warm and reports no initMs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-inv-warm-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    'let n = 0;\nexport const handler = async () => ({ n: ++n });\n');
  const base = { id: 'warm-fn', runtime: 'node', dir, handler: 'index.handler', event: {} };

  const cold = await invoke(base);
  assert.strictEqual(cold.report.cold, true);
  assert.ok(typeof cold.report.initMs === 'number');

  const warm = await invoke(base);
  assert.strictEqual(warm.report.cold, false);
  assert.strictEqual(warm.report.initMs, undefined);
  assert.deepStrictEqual(warm.response, { n: 2 }, 'module scope was not reused');
});

test('forceCold discards the environment and starts fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-inv-cold-'));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    'let n = 0;\nexport const handler = async () => ({ n: ++n });\n');
  const base = { id: 'cold-fn', runtime: 'node', dir, handler: 'index.handler', event: {} };

  await invoke(base);
  const forced = await invoke({ ...base, forceCold: true });
  assert.strictEqual(forced.report.cold, true);
  assert.deepStrictEqual(forced.response, { n: 1 }, 'forceCold reused the old process');
});
```

- [ ] **Step 2: Implement**

In `invoker.js`:

- Keep `command()`, `buildEnv()`, `projectDirProblem()` and the whole result-interpretation block unchanged.
- Add `--warm` to `harnessArgs` and hand `{ cmd, args, env, dir, ... }` to `pool.acquire()`.
- `forceCold` calls `pool.evict(pool.keyFor(...))` before acquiring.
- `out.report.cold = env.cold`, and `initMs` is set only when the envelope carries one — which, per Task 2, is only on a cold invoke.
- Every existing failure branch (`Sandbox.Timedout`, `Project.NotFound`, `Runtime.Unavailable`, `Runtime.ExitError`) stays exactly as-is. The pool's timeout rejection maps onto the existing `Sandbox.Timedout` branch.

In `api/invoke.js`: pass `forceCold: input.forceCold === true` through, and call `pool.evictForFunction(fn.id)` after a successful `runBuild` — a build by definition changed the artifacts the environment loaded.

In `server/schema/function.js`: nothing. `forceCold` is a per-invoke flag, not a stored field, so it must **not** join `ALLOWED_KEYS`.

- [ ] **Step 3: Run the gate**

```bash
npm run test:unit && npm run test:integration && npm run typecheck:server
```
**Every existing invoker and api test must pass unchanged.** They assert on the result envelope, which is exactly what must not shift.

- [ ] **Step 4: Commit**

```bash
git add server/runtime/invoker.js server/api/invoke.js server/types.d.ts tests/
git commit -m "$(cat <<'EOF'
feat(runtime): reuse execution environments across invokes

Warm by default, matching real Lambda: module scope, /tmp and connection
pools now survive between invokes, and initMs is reported only on the
cold one. report.cold says which you got; forceCold discards first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The remaining three harnesses

**Files:**
- Modify: `harnesses/python/harness.py`, `harnesses/java/Harness.java`, `harnesses/provided/harness.mjs`
- Test: `tests/integration/harness-python.test.js`, `tests/integration/java.test.js`, `tests/integration/harness-provided.test.js`

**Context:** Each mirrors Task 2 exactly: resolve the handler once, then loop over length-prefixed stdin requests, writing the envelope to `req.resultFile` and the sentinel to stdout. Without `--warm` each behaves exactly as today.

Do these **one runtime per commit**, running that runtime's tests between. Three separate languages in one commit is three ways to be wrong at once.

**Per runtime, add the same three tests** (module scope reused, `initMs` only on the first, logs not bleeding between invokes), adapted to the language:

- **Python** — `sys.stdin.buffer` for the length-prefixed read. Flush with `sys.stdout.flush(); sys.stderr.flush()` before the sentinel. Module import and `getattr` move above the loop.
- **Java** — read the length prefix bytewise from `System.in` up to `\n`, then exactly that many bytes. Handler class construction moves above the loop. `System.out.flush()` before the sentinel. Rebuild with `sh harnesses/java/build.sh`.
- **`provided`** — the most interesting: this harness already runs a Lambda Runtime API server and the bootstrap already polls `/invocation/next` in a loop, because that is how real custom runtimes work. Warm mode is therefore *more* faithful than what it does today — **keep the bootstrap process alive** and feed it successive invocations instead of killing it in `finish()`. Only tear it down on dispose or timeout.

**`provided` needs one extra test**, because it is the runtime where reuse is most visible:

```js
test('the bootstrap process survives between warm invokes', async () => {
  // A bootstrap that appends its pid to a file each invoke: one distinct pid
  // across N invokes means the process really was reused.
});
```

- [ ] **Step 1: Python — write the tests, implement, run `node --test tests/integration/harness-python.test.js`, commit**
- [ ] **Step 2: Java — same, plus `sh harnesses/java/build.sh`; run `node --test tests/integration/java.test.js`, commit**
- [ ] **Step 3: `provided` — same, plus the pid test; run `node --test tests/integration/harness-provided.test.js`, commit**

---

## Task 7: Shutdown and lifecycle wiring

**Files:**
- Modify: `server/bootstrap.js`, `server/api/functions.js`
- Test: `tests/unit/bootstrap.test.js`

**Context:** Warm environments are live child processes. Quitting without reaping them leaves orphans — the same class of problem `stopAutoStarted` already solves for containers.

- [ ] **Step 1: Write the failing test**

```js
test('stop shuts the warm environment pool down', async () => {
  let shutdowns = 0;
  await bootstrap.start(fakeDeps({ pool: { shutdown: async () => { shutdowns++; } } }));
  await bootstrap.stop();
  assert.strictEqual(shutdowns, 1);
});
```

- [ ] **Step 2: Implement**

`bootstrap.stop()` calls `pool.shutdown()` alongside `triggerManager.stopAll()`, injectable like the rest. In `server/api/functions.js`, `deleteFunction` and `updateFunction` call `pool.evictForFunction(id)` — a deleted function must not leave a process running, and an updated one must not keep serving from the old configuration even if the key happens to match.

- [ ] **Step 3: Run the gate, then commit**

---

## Task 8: Surface it in the UI

**Files:**
- Modify: `web/src/lib/types.ts`, `web/src/components/result-panel.tsx`, `web/src/components/function-header.tsx`, `web/src/lib/api.ts`, `web/src/lib/queries.ts`
- Test: `web/src/components/result-panel.test.tsx`, `web/src/components/function-header.test.tsx`

**Context:** Warm-by-default is invisible without deliberate surfacing, and invisible state is confusing state. A user seeing a 3ms invoke after a 400ms one needs to know why.

- [ ] **Step 1: Write the failing tests**

```tsx
it('labels a cold invoke and shows its init time', () => {
  renderReport({ cold: true, initMs: 412, durationMs: 3 })
  expect(screen.getByText(/cold/i)).toBeInTheDocument()
  expect(screen.getByText(/412/)).toBeInTheDocument()
})

it('labels a warm invoke and shows no init time', () => {
  renderReport({ cold: false, durationMs: 3 })
  expect(screen.getByText(/warm/i)).toBeInTheDocument()
  expect(screen.queryByText(/init/i)).not.toBeInTheDocument()
})

it('sends forceCold when the force-cold control is used', async () => {
  // click it, assert api.invoke was called with forceCold: true
})
```

- [ ] **Step 2: Implement**

Add `cold?: boolean` to the report type (it re-exports from `server/types.d.ts`, so add it there). A badge on the Report tab reading `cold` or `warm`, styled like the existing `http-status-badge`. In `FunctionHeader`, a control that sets `forceCold` on the next invoke — reuse the existing affordance style rather than inventing one.

- [ ] **Step 3: Run `npm --prefix web run test` and `npm --prefix web run typecheck`, then commit**

---

## Task 9: Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`

- [ ] **Step 1: Replace ARCHITECTURE.md's "Invoking a handler" section**

It currently describes spawn-per-invoke and carries a "Changing in Phase D" note. Replace with the real protocol: length-prefixed stdin requests, the result file, the sentinel, the pool key, and every eviction rule. Delete the forward-reference note.

- [ ] **Step 2: Add a README section**

Under the existing structure, explain warm invokes in user terms: what persists between invokes, that `initMs` appears only on a cold start, what forces a cold one (editing a source file, changing configuration, a build, a timeout, 5 minutes idle), and where the force-cold control is. **State plainly that a handler logging after it returns will have that output attributed to the next invoke, exactly as on real Lambda** — someone will hit it and needs to find it documented rather than think it is a bug.

- [ ] **Step 3: Commit**

---

## Done criteria

- [ ] `npm run test:unit` passes
- [ ] `npm run test:integration` passes except the three known-broken `trigger-docker` cases
- [ ] `npm run test:web`, `npm run typecheck:server`, `npm --prefix web run typecheck` pass
- [ ] `npm run lint` reports no new errors (2 pre-existing)
- [ ] A second invoke of an unchanged function reuses module scope, in all four runtimes
- [ ] Editing a handler file makes the next invoke cold — verified by hand, not only by test
- [ ] `report.cold` is present on every invoke, and the UI shows it
- [ ] Quitting the CLI leaves no orphaned harness processes:
      `ps -eo command | grep -c harness` returns 0 afterwards
