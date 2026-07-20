// AWS Lambda Playground "provided" (OS-only) harness. Emulates the Lambda
// Runtime API on a loopback port and spawns the project's executable
// (bootstrap), so real AWS custom-runtime bootstraps run unchanged.
// Same contract as the other harnesses: event on stdin, envelope JSON to
// --result-file, fresh process per invoke.
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

const resultFile = arg('--result-file');
const handlerSpec = arg('--handler', 'bootstrap');
const timeoutMs = parseInt(arg('--timeout-ms', '30000'), 10);
const memoryMb = parseInt(arg('--memory-mb', '128'), 10);
const requestId = arg('--request-id', randomUUID());

let done = false;
function finish(payload) {
  if (done) return;
  done = true;
  fs.writeFileSync(resultFile, JSON.stringify(payload));
  if (child?.pid) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  server.close();
  // Exit on the next tick so in-flight response writes to the bootstrap
  // (which is about to die anyway) don't throw.
  setImmediate(() => process.exit(0));
}

const event = JSON.parse(fs.readFileSync(0, 'utf8'));
const executable = path.resolve(process.cwd(), handlerSpec);

try {
  fs.accessSync(executable, fs.constants.X_OK);
  if (!fs.statSync(executable).isFile()) throw new Error('not a file');
} catch {
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: false, phase: 'init', durationMs: 0,
    error: {
      type: 'Runtime.InvalidEntrypoint',
      message: `'${handlerSpec}' is not an executable file in the project directory`,
      stackTrace: [],
    },
  }));
  process.exit(0);
}

const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'playground';
const arn = `arn:aws:lambda:${process.env.AWS_REGION || 'us-east-1'}:000000000000:function:${functionName}`;
const deadline = Date.now() + timeoutMs;
let startedAt = null;
let polled = false;

function durationMs() {
  return startedAt === null ? 0 : Number(process.hrtime.bigint() - startedAt) / 1e6;
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
    if (startedAt === null) startedAt = process.hrtime.bigint();
    polled = true;
    res.writeHead(200, {
      'content-type': 'application/json',
      'lambda-runtime-aws-request-id': requestId,
      'lambda-runtime-deadline-ms': String(deadline),
      'lambda-runtime-invoked-function-arn': arn,
      'lambda-runtime-trace-id': `Root=1-00000000-${requestId.replace(/-/g, '').slice(0, 24)}`,
    });
    return res.end(JSON.stringify(event));
  }
  if (req.method === 'POST' && url === `${BASE}/invocation/${requestId}/response`) {
    const body = await readBody(req);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"status":"OK"}');
    let response;
    try { response = JSON.parse(body); } catch { response = body; }
    return finish({ ok: true, phase: 'invoke', response, durationMs: durationMs() });
  }
  if (req.method === 'POST' && url === `${BASE}/invocation/${requestId}/error`) {
    const body = await readBody(req);
    res.writeHead(202);
    res.end();
    return finish({ ok: false, phase: 'invoke', durationMs: durationMs(),
      error: parseError(body) });
  }
  if (req.method === 'POST' && url === `${BASE}/init/error`) {
    const body = await readBody(req);
    res.writeHead(202);
    res.end();
    return finish({ ok: false, phase: 'init', durationMs: 0, error: parseError(body) });
  }
  res.writeHead(404);
  res.end();
});

let child = null;
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
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
    finish({ ok: false, phase: 'init', durationMs: 0, error: {
      type: 'Runtime.InvalidEntrypoint',
      message: `Could not start '${handlerSpec}': ${err.message}`,
      stackTrace: [] } });
  });
  child.on('exit', (code) => {
    finish({ ok: false, phase: polled ? 'invoke' : 'init', durationMs: durationMs(),
      error: {
        type: 'Runtime.ExitError',
        message: `Bootstrap exited with code ${code} before posting a response`,
        stackTrace: [] } });
  });
});
