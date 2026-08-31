const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVenvPython } = require('./detect');
const { hasOwnTracingSetup } = require('../trace/auto-trace-detect');
const traceReceiver = require('../trace/receiver');
const traceCollector = require('../trace/collector');
const pool = require('./pool');

// Runtimes whose harness understands --warm and serves a request loop. The
// rest still get a fresh process per invoke, which is exactly what they did
// before; a runtime joins this set in the commit that converts its harness.
const WARM_RUNTIMES = new Set(['node']);

const HARNESS_DIR = path.join(__dirname, '..', '..', 'harnesses');
const AUTO_TRACE_BOOTSTRAP = path.join(HARNESS_DIR, 'node', 'auto-trace-bootstrap.cjs');

// Everything harnesses/node/auto-trace-bootstrap.cjs requires -- all
// optionalDependencies (see package.json). That file is loaded via --require
// in a brand-new child process, before the harness itself runs, so a missing
// package there crashes the child with a bare stack trace and no result
// file: invoker would report every field of that as an unhelpful "Runtime
// exited without providing a result". Checking resolvability here, in the
// parent, lets us skip --require and report *why* tracing didn't happen
// instead, while still running the handler normally.
const AUTO_TRACE_PACKAGES = [
  '@opentelemetry/api',
  '@opentelemetry/context-async-hooks',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/instrumentation',
  '@opentelemetry/auto-instrumentations-node',
];

function autoTraceUnavailableMessage() {
  const missing = AUTO_TRACE_PACKAGES.filter((pkg) => {
    try { require.resolve(pkg); return false; } catch { return true; }
  });
  if (missing.length === 0) return null;
  return `Auto-trace needs ${missing.map((p) => `\`${p}\``).join(', ')}; `
    + `run \`npm i ${missing.join(' ')}\` to enable it.`;
}

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

function command(opts, harnessArgs, nodeRequireArgs = []) {
  if (opts.runtime === 'python') {
    const interp = findVenvPython(opts.dir) || 'python3';
    return { cmd: interp, args: [path.join(HARNESS_DIR, 'python', 'harness.py'), ...harnessArgs] };
  }
  if (opts.runtime === 'node') {
    return { cmd: process.execPath, args: [...nodeRequireArgs, path.join(HARNESS_DIR, 'node', 'harness.mjs'), ...harnessArgs] };
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
  /** @type {Record<string, string>} */
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.AWS_LAMBDA_FUNCTION_NAME = opts.name || 'playground';
  env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = String(memoryMb);
  env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  env.AWS_REGION = 'us-east-1';
  // undefined when the span receiver failed to bind (e.g. a sandbox that
  // disallows loopback listens). Injecting nothing degrades to "tracing
  // unavailable"; injecting the string "undefined" would instead make every
  // OTel-enabled handler fail on an unparseable endpoint.
  if (otlpEndpoint) {
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = otlpEndpoint;
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';
    // Cold only. A warm process outlives the invoke, so stamping a per-invoke
    // id here would make every later invoke's spans report the first one's;
    // the caller replaces this with faas.instance for warm runtimes.
    env.OTEL_RESOURCE_ATTRIBUTES = `faas.invocation_id=${requestId}`;
  }
  Object.assign(env, opts.env || {});
  return env;
}

// One process per invoke. Kept as its own function so the warm path and this
// one stay visibly the same shape, and so a runtime can be converted to the
// request loop without touching the other's behaviour.
function spawnOnce({ cmd, args, env, dir, event, timeoutMs }) {
  return new Promise((resolve) => {
    let logs = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: dir, env, detached: process.platform !== 'win32' });
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
    child.stdin.end(JSON.stringify(event ?? {}));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, logs, timedOut }); });
  });
}

async function invoke(opts) {
  const requestId = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryMb = opts.memoryMb ?? 128;
  const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
  // --result-file/--request-id still go on the command line so a harness that
  // is started cold (or crashes before its first request) has somewhere to
  // report an init failure. In warm mode each request carries its own.
  const warm = WARM_RUNTIMES.has(opts.runtime) && !opts.disableWarm;
  const harnessArgs = ['--handler', opts.handler, '--result-file', resultFile,
    '--timeout-ms', String(timeoutMs), '--memory-mb', String(memoryMb),
    '--request-id', requestId, ...(warm ? ['--warm'] : [])];
  const wantsAutoTrace = opts.runtime === 'node' && opts.autoTrace && !hasOwnTracingSetup(opts.dir);
  const autoTraceError = wantsAutoTrace ? autoTraceUnavailableMessage() : null;
  const nodeRequireArgs = (wantsAutoTrace && !autoTraceError)
    ? ['--require', AUTO_TRACE_BOOTSTRAP]
    : [];
  const { cmd, args } = command(opts, harnessArgs, nodeRequireArgs);
  const otlpEndpoint = await traceReceiver.endpoint();
  const env = buildEnv(opts, memoryMb, requestId, otlpEndpoint);

  const startedAt = Date.now();
  const dirProblem = projectDirProblem(opts.dir);
  const poolOpts = {
    id: opts.id, runtime: opts.runtime, dir: opts.dir, handler: opts.handler,
    env, memoryMb, jarPath: opts.jarPath ?? null, autoTrace: opts.autoTrace === true,
    command: { cmd, args },
  };
  // A warm process reports the environment it belongs to rather than a single
  // invoke, and the collector resolves that back to whichever invoke is in
  // flight. keyFor ignores this var precisely so setting it here is not
  // circular.
  const instanceId = warm ? pool.keyFor(poolOpts) : null;
  if (instanceId && env.OTEL_RESOURCE_ATTRIBUTES) {
    env.OTEL_RESOURCE_ATTRIBUTES = `faas.instance=${instanceId}`;
  }
  traceCollector.open(requestId, opts.id, instanceId);
  // An explicit cold start discards whatever was cached before acquiring, so
  // the next invoke genuinely re-runs module initialisation.
  if (opts.forceCold) pool.evict(pool.keyFor(poolOpts));

  let run;
  if (dirProblem) {
    run = { logs: '', dirProblem, cold: true };
  } else if (!warm) {
    // One process per invoke: the original path, still used by every runtime
    // whose harness has not been converted to a request loop.
    run = await spawnOnce({ cmd, args, env, dir: opts.dir, event: opts.event, timeoutMs });
    try { run.envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
    try { fs.unlinkSync(resultFile); } catch {}
    run.cold = true;
  } else {
    let environment = null;
    try {
      environment = await pool.acquire(poolOpts);
      const cold = environment.cold;
      const { logs, envelope: got } = await environment.send({ event: opts.event ?? {}, timeoutMs });
      run = { logs, envelope: got, cold };
    } catch (err) {
      // A spawn failure surfaces here rather than as an 'error' event, since
      // the pool owns the child process now.
      run = {
        logs: '',
        cold: environment ? environment.cold : true,
        timedOut: err.timedOut === true,
        spawnError: err.timedOut ? undefined : err,
      };
    }
  }
  const wallMs = Date.now() - startedAt;

  const envelope = run.envelope ?? null;

  /** @type {import('../types').InvokeOutcome} */
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
      message: 'Runtime exited without providing a result'
        + (run.exit === undefined || run.exit === null ? '' : ` (exit code ${run.exit})`),
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
    timedOut: run.timedOut === true,
    // Which kind of invoke this was. Warm-by-default is otherwise invisible,
    // and an unexplained 3ms after a 400ms is more confusing than useful.
    cold: run.cold === true,
  };
  if (envelope?.initMs != null) {
    out.report.initMs = Math.round(envelope.initMs * 100) / 100;
  }
  const { spans } = traceCollector.snapshotAndStartWindow(requestId);
  // No spans will ever arrive when auto-trace couldn't start -- pending:
  // false so the UI's trace poll (which relies on pending to know when to
  // stop) doesn't keep hitting the trace endpoint forever waiting on them.
  out.trace = autoTraceError ? { spans, pending: false, error: autoTraceError } : { spans, pending: true };
  return out;
}

module.exports = { invoke };
