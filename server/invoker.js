const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVenvPython } = require('./detect');

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

function buildEnv(opts, memoryMb) {
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.AWS_LAMBDA_FUNCTION_NAME = opts.name || 'playground';
  env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = String(memoryMb);
  env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  env.AWS_REGION = 'us-east-1';
  Object.assign(env, opts.env || {});
  return env;
}

async function invoke(opts) {
  const requestId = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryMb = opts.memoryMb ?? 128;
  const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
  const harnessArgs = ['--handler', opts.handler, '--result-file', resultFile,
    '--timeout-ms', String(timeoutMs), '--memory-mb', String(memoryMb),
    '--request-id', requestId];
  const { cmd, args } = command(opts, harnessArgs);
  const env = buildEnv(opts, memoryMb);

  const startedAt = Date.now();
  const run = await new Promise((resolve) => {
    let logs = '';
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.dir, env, detached: process.platform !== 'win32' });
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
  return out;
}

module.exports = { invoke };
