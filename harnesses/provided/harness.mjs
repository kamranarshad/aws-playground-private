// AWS Lambda Playground "provided" (OS-only) harness. Emulates the Lambda
// Runtime API on a loopback port and spawns the project's executable
// (bootstrap), so real AWS custom-runtime bootstraps run unchanged.
//
// Two modes, like the other harnesses. Without --warm it serves exactly one
// invocation and exits. With --warm it keeps the bootstrap process alive and
// feeds it successive invocations -- which is not a compromise but the more
// faithful behaviour: a real custom runtime is *written* as a loop around
// /invocation/next, and killing it after one response is what the cold path
// does artificially. See server/runtime/protocol.js for the framing.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const harnessStart = process.hrtime.bigint();
const resultFile = arg('--result-file');
const handlerSpec = arg('--handler', 'bootstrap');
const timeoutMs = parseInt(arg('--timeout-ms', '30000'), 10);
const requestId = arg('--request-id', randomUUID());
const warm = process.argv.includes('--warm');

const SENTINEL_PREFIX = '\0AWSPLAY-END:';
const SENTINEL_SUFFIX = '\0';

// Writes the sentinel and waits for it to actually reach the pipe. A bare
// write() followed by process.exit() can discard it: writes to a pipe are
// asynchronous, and exiting drops whatever is still buffered -- which the
// parent then waits for until the invoke times out.
function writeSentinel(requestId) {
  return new Promise((resolve) => {
    process.stdout.write(SENTINEL_PREFIX + requestId + SENTINEL_SUFFIX, resolve);
  });
}

function flushStdio() {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending === 0) resolve(); };
    process.stdout.write('', done);
    process.stderr.write('', done);
  });
}

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

const executable = path.resolve(process.cwd(), handlerSpec);

function writeEnvelope(file, payload) {
  fs.writeFileSync(file, JSON.stringify(payload));
}

try {
  fs.accessSync(executable, fs.constants.X_OK);
  if (!fs.statSync(executable).isFile()) throw new Error('not a file');
} catch {
  writeEnvelope(resultFile, {
    ok: false, phase: 'init', durationMs: 0,
    error: {
      type: 'Runtime.InvalidEntrypoint',
      message: `'${handlerSpec}' is not an executable file in the project directory`,
      stackTrace: [],
    },
  });
  process.exit(0);
}

const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'playground';
const arn = `arn:aws:lambda:${process.env.AWS_REGION || 'us-east-1'}:000000000000:function:${functionName}`;

// The invocation currently being served. The bootstrap loops on
// /invocation/next, so between invokes it simply blocks there -- exactly as a
// real custom runtime does against the real Runtime API.
let current = null;
let waiter = null;
let firstInvocation = true;
let bootstrapDead = null;
let bootstrapExited = false;

function nextInvocation() {
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => { waiter = resolve; });
}

function offer(invocation) {
  current = invocation;
  if (waiter) { const w = waiter; waiter = null; w(invocation); }
}

// Completes the invocation in flight. In cold mode this is terminal; in warm
// mode the bootstrap goes back to polling and the next request reuses it.
async function settle(payload) {
  const inv = current;
  if (!inv || inv.settled) return;
  inv.settled = true;
  writeEnvelope(inv.resultFile, payload);
  if (!warm) {
    killBootstrap();
    server.close();
    setImmediate(() => process.exit(0));
    return;
  }
  await flushStdio();
  await writeSentinel(inv.requestId);
  // Cleared only now: until the parent has its sentinel this invocation is
  // still in flight, and treating the harness as idle any earlier would let
  // an exiting bootstrap take it down before the answer was written.
  current = null;
  inv.done();
}

function killBootstrap() {
  if (child?.pid) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => resolve(body));
  });
}

function parseError(body) {
  try {
    const e = JSON.parse(body);
    return {
      type: e.errorType || 'Runtime.UnknownError',
      message: e.errorMessage || String(body),
      stackTrace: Array.isArray(e.stackTrace) ? e.stackTrace : [],
    };
  } catch {
    return { type: 'Runtime.UnknownError', message: String(body), stackTrace: [] };
  }
}

const BASE = '/2018-06-01/runtime';
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === `${BASE}/invocation/next`) {
    // Blocks until there is something to serve, which is what makes a warm
    // bootstrap sit idle between invokes rather than spin or exit.
    const inv = await nextInvocation();
    inv.startedAt = process.hrtime.bigint();
    inv.polled = true;
    res.writeHead(200, {
      'content-type': 'application/json',
      'lambda-runtime-aws-request-id': inv.requestId,
      'lambda-runtime-deadline-ms': String(inv.deadline),
      'lambda-runtime-invoked-function-arn': arn,
      'lambda-runtime-trace-id': `Root=1-00000000-${inv.requestId.replace(/-/g, '').slice(0, 24)}`,
    });
    return res.end(JSON.stringify(inv.event));
  }

  const inv = current;
  if (inv && req.method === 'POST' && url === `${BASE}/invocation/${inv.requestId}/response`) {
    const body = await readBody(req);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"status":"OK"}');
    let response;
    try { response = JSON.parse(body); } catch { response = body; }
    return settle({
      ok: true, phase: 'invoke', response, durationMs: durationOf(inv),
      ...(inv.initMs !== null ? { initMs: inv.initMs } : {}),
    });
  }
  if (inv && req.method === 'POST' && url === `${BASE}/invocation/${inv.requestId}/error`) {
    const body = await readBody(req);
    res.writeHead(202);
    res.end();
    return settle({ ok: false, phase: 'invoke', durationMs: durationOf(inv), error: parseError(body) });
  }
  if (req.method === 'POST' && url === `${BASE}/init/error`) {
    const body = await readBody(req);
    res.writeHead(202);
    res.end();
    return settle({ ok: false, phase: 'init', durationMs: 0, error: parseError(body) });
  }
  res.writeHead(404);
  res.end();
});

function durationOf(inv) {
  return inv.startedAt === null ? 0 : Number(process.hrtime.bigint() - inv.startedAt) / 1e6;
}

let child = null;

function startBootstrap(port) {
  child = spawn(executable, [], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${port}`,
      _HANDLER: handlerSpec,
    },
  });
  child.on('error', (err) => {
    bootstrapDead = {
      ok: false, phase: 'init', durationMs: 0,
      error: {
        type: 'Runtime.InvalidEntrypoint',
        message: `Could not start '${handlerSpec}': ${err.message}`,
        stackTrace: [],
      },
    };
    if (current) settle(bootstrapDead);
  });
  child.on('exit', (code) => {
    bootstrapExited = true;
    const inv = current;
    // Exited between invocations: it is simply not a loop. That is fine --
    // the next request restarts it (see ensureBootstrap). Exited
    // mid-invocation is a genuine failure and the caller needs the reason.
    if (!inv || inv.settled) return;
    bootstrapDead = {
      ok: false, phase: inv.polled ? 'invoke' : 'init',
      durationMs: durationOf(inv),
      error: {
        type: 'Runtime.ExitError',
        message: `Bootstrap exited with code ${code} before posting a response`,
        stackTrace: [],
      },
    };
    settle(bootstrapDead);
  });
}

// Restarts the bootstrap if it is no longer running, and reports whether it
// had to. initStart moves with it so the reported init time measures the
// restart rather than the harness's original startup.
let initStart = harnessStart;
async function ensureBootstrap() {
  if (!bootstrapExited) return false;
  bootstrapExited = false;
  bootstrapDead = null;
  initStart = process.hrtime.bigint();
  startBootstrap(server.address().port);
  return true;
}

server.listen(0, '127.0.0.1', async () => {
  startBootstrap(server.address().port);

  if (!warm) {
    offer({
      requestId, event: JSON.parse(fs.readFileSync(0, 'utf8')), resultFile,
      deadline: Date.now() + timeoutMs, startedAt: null,
      initMs: Number(process.hrtime.bigint() - harnessStart) / 1e6,
      polled: false, settled: false, done: () => {},
    });
    return;
  }

  for await (const req of requests(process.stdin)) {
    // A bootstrap written as a loop is still sitting on /invocation/next and
    // this is a no-op. One that served a single invocation and exited gets
    // restarted here, so it behaves exactly as it did when every invoke had
    // its own process -- just without a new harness. Either way the restart
    // is a real initialisation, so it is reported as one.
    const restarted = await ensureBootstrap();
    await new Promise((resolve) => {
      offer({
        requestId: req.requestId, event: req.event, resultFile: req.resultFile,
        deadline: Date.now() + req.timeoutMs, startedAt: null,
        initMs: (firstInvocation || restarted)
          ? Number(process.hrtime.bigint() - initStart) / 1e6 : null,
        polled: false, settled: false, done: resolve,
      });
      firstInvocation = false;
    });
  }
  killBootstrap();
  server.close();
  process.exit(0);
});
