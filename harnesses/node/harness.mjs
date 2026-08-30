// AWS Lambda Playground node harness. Run with cwd = the user's project
// directory. Reads event JSON from stdin, imports <file>.<export>, invokes
// it with (event, context[, callback]), writes an envelope to --result-file.
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

function writeResult(payload) {
  fs.writeFileSync(resultFile, JSON.stringify(payload));
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

const event = JSON.parse(fs.readFileSync(0, 'utf8'));

const dot = handlerSpec.lastIndexOf('.');
let fn;
try {
  if (dot <= 0) throw namedError('Runtime.MalformedHandlerName',
    `Bad handler '${handlerSpec}': expected 'file.export'`);
  const filePart = handlerSpec.slice(0, dot);
  const exportName = handlerSpec.slice(dot + 1);
  const base = path.resolve(process.cwd(), filePart);
  const candidate = ['.mjs', '.js', '.cjs'].map(e => base + e).find(f => fs.existsSync(f));
  if (!candidate) throw namedError('Runtime.ImportModuleError',
    `Cannot find module file for '${filePart}' (tried .mjs, .js, .cjs)`);
  const mod = await import(pathToFileURL(candidate).href);
  fn = mod[exportName] ?? mod.default?.[exportName];
  if (typeof fn !== 'function') throw namedError('Runtime.HandlerNotFound',
    `Handler '${exportName}' is not an exported function in ${candidate}`);
} catch (err) {
  writeResult({ ok: false, phase: 'init', durationMs: 0, error: shape(err) });
  process.exit(0);
}

const deadline = Date.now() + timeoutMs;
const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'playground';
const context = {
  functionName,
  functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
  memoryLimitInMB: String(memoryMb),
  awsRequestId: requestId,
  invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION || 'us-east-1'}:000000000000:function:${functionName}`,
  logGroupName: `/aws/lambda/${functionName}`,
  logStreamName: 'playground',
  getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
};

const start = process.hrtime.bigint();
const initMs = Number(start - harnessStart) / 1e6;
try {
  const response = await new Promise((resolve, reject) => {
    const maybe = fn(event, context, (err, res) => (err ? reject(err) : resolve(res)));
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    else if (fn.length < 3) resolve(maybe);
    // else: 3-arg callback style — wait for the callback
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  try { await globalThis.__awsPlaygroundFlushTracing?.(); } catch {}
  writeResult({ ok: true, phase: 'invoke', response: response ?? null, durationMs, initMs });
} catch (err) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  try { await globalThis.__awsPlaygroundFlushTracing?.(); } catch {}
  writeResult({ ok: false, phase: 'invoke', durationMs, error: shape(err) });
}
process.exit(0);
