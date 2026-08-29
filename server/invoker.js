const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVenvPython } = require('./detect');
const traceReceiver = require('./trace-receiver');
const traceCollector = require('./trace-collector');

const HARNESS_DIR = path.join(__dirname, '..', 'harnesses');

// The host environment is NOT inherited — only this allowlist crosses over,
// so a handler can't accidentally pick up your shell's AWS credentials.
// Network plumbing is the exception: on a proxied or TLS-inspecting network
// every outbound SDK call fails with an opaque timeout unless the proxy and
// CA-bundle vars follow the handler in. Deliberately absent: AWS_PROFILE and
// friends — silently handing a local handler real AWS credentials is exactly
// what this allowlist exists to prevent.
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'JAVA_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'AWS_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
];

function command(opts, harnessArgs) {
  if (opts.runtime === 'python') {
    const interp = findVenvPython(opts.dir) || 'python3';
    return { cmd: interp, args: [path.join(HARNESS_DIR, 'python', 'harness.py'), ...harnessArgs] };
  }
  if (opts.runtime === 'node') {
    return { cmd: process.execPath, args: [path.join(HARNESS_DIR, 'node', 'harness.mjs'), ...harnessArgs] };
  }
  if (opts.runtime === 'provided') {
    return { cmd: process.execPath, args: [path.join(HARNESS_DIR, 'provided', 'harness.mjs'), ...harnessArgs] };
  }
  if (opts.runtime === 'java') {
    const harnessJar = path.join(HARNESS_DIR, 'java', 'harness.jar');
    const cp = [harnessJar, opts.jarPath].filter(Boolean).join(path.delimiter);
    return { cmd: 'java', args: ['-cp', cp, 'Harness', ...harnessArgs] };
  }
  throw new Error(`Unknown runtime: ${opts.runtime}`);
}

// spawn() resolves the command relative to the child's cwd, so a missing cwd
// comes back as ENOENT naming the *command* — "could not start node" when node
// is fine and it's the project folder that moved. Check the folder ourselves so
// the error points at the thing that's actually wrong.
function projectDirProblem(dir) {
  if (!dir) return 'This function has no project folder set.';
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return `Project folder not found: '${dir}'. It may have been moved, `
        + 'renamed, or deleted — re-point the function at its current location.';
    }
    return `Project folder '${dir}' could not be read: ${err.message}`;
  }
  if (!stat.isDirectory()) return `Project path '${dir}' is not a folder.`;
  return null;
}

function buildEnv(opts, memoryMb, requestId, otlpEndpoint) {
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.AWS_LAMBDA_FUNCTION_NAME = opts.name || 'playground';
  env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = String(memoryMb);
  env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  env.AWS_REGION = 'us-east-1';
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = otlpEndpoint;
  env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';
  env.OTEL_RESOURCE_ATTRIBUTES = `faas.invocation_id=${requestId}`;
  Object.assign(env, opts.env || {});
  return env;
}

async function invoke(opts) {
  const requestId = crypto.randomUUID();
  traceCollector.open(requestId, opts.id);
  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryMb = opts.memoryMb ?? 128;
  const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
  const harnessArgs = ['--handler', opts.handler, '--result-file', resultFile,
    '--timeout-ms', String(timeoutMs), '--memory-mb', String(memoryMb),
    '--request-id', requestId];
  const { cmd, args } = command(opts, harnessArgs);
  const otlpEndpoint = await traceReceiver.endpoint();
  const env = buildEnv(opts, memoryMb, requestId, otlpEndpoint);

  const startedAt = Date.now();
  const dirProblem = projectDirProblem(opts.dir);
  const run = dirProblem ? { exit: null, logs: '', timedOut: false, dirProblem } : await new Promise((resolve) => {
    let logs = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.dir, env, detached: process.platform !== 'win32' });
    } catch (err) {
      // spawn throws synchronously for some cwd failures (e.g. ENOTDIR) instead
      // of emitting 'error', which would escape as an unhandled rejection.
      resolve({ exit: null, logs, timedOut, spawnError: err });
      return;
    }
    child.on('error', (err) => resolve({ exit: null, logs, timedOut, spawnError: err }));
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(opts.event ?? {}));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, logs, timedOut }); });
  });
  const wallMs = Date.now() - startedAt;

  let envelope = null;
  try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  try { fs.unlinkSync(resultFile); } catch {}

  let out;
  if (run.timedOut) {
    out = { ok: false, phase: 'invoke', error: {
      type: 'Sandbox.Timedout',
      message: `Task timed out after ${(timeoutMs / 1000).toFixed(2)} seconds`,
      stackTrace: [] } };
  } else if (run.dirProblem) {
    out = { ok: false, phase: 'init', error: {
      type: 'Project.NotFound',
      message: run.dirProblem,
      stackTrace: [] } };
  } else if (run.spawnError) {
    out = { ok: false, phase: 'init', error: {
      type: 'Runtime.Unavailable',
      message: `Could not start '${cmd}': ${run.spawnError.message}. Is the ${opts.runtime} runtime installed?`,
      stackTrace: [] } };
  } else if (!envelope) {
    out = { ok: false, phase: 'invoke', error: {
      type: 'Runtime.ExitError',
      message: `Runtime exited without providing a result (exit code ${run.exit})`,
      stackTrace: [] } };
  } else {
    out = { ok: envelope.ok, phase: envelope.phase,
      response: envelope.response, error: envelope.error };
  }

  const durationMs = envelope?.durationMs ?? wallMs;
  out.logs = run.logs;
  out.report = {
    requestId,
    durationMs: Math.round(durationMs * 100) / 100,
    billedMs: Math.max(1, Math.ceil(durationMs)),
    memoryMb,
    timedOut: run.timedOut,
  };
  if (envelope?.initMs != null) {
    out.report.initMs = Math.round(envelope.initMs * 100) / 100;
  }
  const { spans } = traceCollector.snapshotAndStartWindow(requestId);
  out.trace = { spans, pending: true };
  return out;
}

module.exports = { invoke };
