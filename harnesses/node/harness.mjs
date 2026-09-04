// AWS Lambda Playground node harness. Run with cwd = the user's project
// directory. Imports <file>.<export> once, then invokes it with
// (event, context[, callback]) and writes an envelope to a result file.
//
// Two modes. Without --warm it reads one event from stdin, writes the
// envelope to --result-file and exits -- one process per invoke. With --warm
// it serves length-prefixed requests from stdin until stdin closes, keeping
// module scope, /tmp and any connection pools alive between them, which is
// what real Lambda does with an execution environment. See
// server/runtime/protocol.js for the framing.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const resultFile = arg('--result-file');
const handlerSpec = arg('--handler', '');
const timeoutMs = parseInt(arg('--timeout-ms', '30000'), 10);
const memoryMb = parseInt(arg('--memory-mb', '128'), 10);
const requestId = arg('--request-id', randomUUID());
const warm = process.argv.includes('--warm');

function writeResult(file, payload) {
  fs.writeFileSync(file, JSON.stringify(payload));
}

// Waits for both streams to drain rather than assuming they have: the parent
// cuts this invoke's logs at the sentinel, so anything still queued when the
// sentinel goes out would be misattributed to the next invoke.
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

function shape(err) {
  return {
    type: err?.name || 'Error',
    message: err?.message || String(err),
    stackTrace: (err?.stack || '').split('\n'),
  };
}

function namedError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const harnessStart = process.hrtime.bigint();

// Resolved once. In warm mode its cost is the initMs reported on the first
// response only -- every later invoke reuses this exact module instance,
// which is what makes module-scope state persist the way it does on Lambda.
async function resolveHandler() {
  const dot = handlerSpec.lastIndexOf('.');
  if (dot <= 0) throw namedError('Runtime.MalformedHandlerName',
    `Bad handler '${handlerSpec}': expected 'file.export'`);
  const filePart = handlerSpec.slice(0, dot);
  const exportName = handlerSpec.slice(dot + 1);
  const base = path.resolve(process.cwd(), filePart);
  const candidate = ['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts'].map(e => base + e).find(f => fs.existsSync(f));
  if (!candidate) throw namedError('Runtime.ImportModuleError',
    `Cannot find module file for '${filePart}' (tried .mjs, .js, .cjs, .ts, .mts, .cts)`);
  const mod = await import(pathToFileURL(candidate).href);
  const fn = mod[exportName] ?? mod.default?.[exportName];
  if (typeof fn !== 'function') throw namedError('Runtime.HandlerNotFound',
    `Handler '${exportName}' is not an exported function in ${candidate}`);
  return fn;
}

let handlerFn;
let initMs;
try {
  handlerFn = await resolveHandler();
  initMs = Number(process.hrtime.bigint() - harnessStart) / 1e6;
} catch (err) {
  const envelope = { ok: false, phase: 'init', durationMs: 0, error: shape(err) };
  if (!warm) {
    writeResult(resultFile, envelope);
    process.exit(0);
  }
  // In warm mode the parent is waiting on a sentinel for the request *it*
  // sent, not for the one named on the command line, so the init failure has
  // to be reported as the answer to a real request. There is no handler to
  // serve a second one with, so exit after answering.
  for await (const req of requests(process.stdin)) {
    writeResult(req.resultFile, envelope);
    await flushStdio();
    process.stdout.write(`\0AWSPLAY-END:${req.requestId}\0`);
    break;
  }
  process.exit(0);
}

function buildContext(id, deadline, memory) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'playground';
  return {
    functionName,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
    memoryLimitInMB: String(memory),
    awsRequestId: id,
    invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION || 'us-east-1'}:000000000000:function:${functionName}`,
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: 'playground',
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
  };
}

async function runOne(req) {
  const context = buildContext(req.requestId, Date.now() + req.timeoutMs, req.memoryMb);
  const start = process.hrtime.bigint();
  try {
    const response = await new Promise((resolve, reject) => {
      const maybe = handlerFn(req.event, context, (err, res) => (err ? reject(err) : resolve(res)));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
      else if (handlerFn.length < 3) resolve(maybe);
      // else: 3-arg callback style — wait for the callback
    });
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    try { await globalThis.__awsPlaygroundFlushTracing?.(); } catch {}
    writeResult(req.resultFile, {
      ok: true, phase: 'invoke', response: response ?? null, durationMs,
      ...(req.initMs !== undefined ? { initMs: req.initMs } : {}),
    });
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    try { await globalThis.__awsPlaygroundFlushTracing?.(); } catch {}
    writeResult(req.resultFile, { ok: false, phase: 'invoke', durationMs, error: shape(err) });
  }
}

if (!warm) {
  await runOne({
    requestId, resultFile, event: JSON.parse(fs.readFileSync(0, 'utf8')),
    timeoutMs, memoryMb, initMs,
  });
  process.exit(0);
}

let first = true;
for await (const req of requests(process.stdin)) {
  await runOne({ ...req, initMs: first ? initMs : undefined });
  first = false;
  await flushStdio();
  process.stdout.write(`\0AWSPLAY-END:${req.requestId}\0`);
}
process.exit(0);
