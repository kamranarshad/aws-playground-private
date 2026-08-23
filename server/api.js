const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject } = require('./detect');
const { findJar } = require('./detect');
const envfile = require('./envfile');
const localServices = require('./services');
const projectconfig = require('./projectconfig');
const { runBuild } = require('./build');
const { invoke } = require('./invoker');
const history = require('./history');

const RUNTIMES = ['python', 'node', 'java', 'provided'];
const inFlight = new Set();

function checkRuntime(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

async function health() {
  const [python, node, java, provided] = await Promise.all([
    checkRuntime('python3', ['--version']),
    checkRuntime('node', ['--version']),
    checkRuntime('java', ['-version']),
    checkRuntime('sh', ['-c', 'echo ok']),
  ]);
  return { status: 200, body: { runtimes: { python, node, java, provided } } };
}

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

// Shared between create (fields always present) and update (fields present
// only when patched) so a PATCH can't put the store into a state POST would
// have rejected — e.g. a non-numeric timeoutMs, which downstream clamps
// setTimeout to ~1ms and SIGKILLs every future invoke almost instantly.
function fieldError(fields) {
  if ('runtime' in fields && !RUNTIMES.includes(fields.runtime)) {
    return `unsupported runtime '${fields.runtime}'`;
  }
  if ('path' in fields
    && (!fs.existsSync(fields.path) || !fs.statSync(fields.path).isDirectory())) {
    return `path is not a directory: ${fields.path}`;
  }
  if ('timeoutMs' in fields && !(Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0)) {
    return 'timeoutMs must be a positive number';
  }
  if ('memoryMb' in fields && !(Number.isFinite(fields.memoryMb) && fields.memoryMb > 0)) {
    return 'memoryMb must be a positive number';
  }
  return null;
}

function createFunction(input) {
  const { name, path: dir, runtime } = input || {};
  if (!name || !dir || !runtime) {
    return { status: 400, body: { error: 'name, path and runtime are required' } };
  }
  const err = fieldError(input);
  if (err) return { status: 400, body: { error: err } };
  return { status: 201, body: store.create(input) };
}

function updateFunction(id, patch) {
  const p = patch || {};
  const err = fieldError(p);
  if (err) return { status: 400, body: { error: err } };
  const fn = store.update(id, p);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: fn };
}

function deleteFunction(id) {
  if (inFlight.has(id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  if (!store.remove(id)) return { status: 404, body: { error: 'function not found' } };
  history.clear(id);
  return { status: 204 };
}

function detect(input) {
  const dir = (input || {}).path;
  if (!dir) return { status: 400, body: { error: 'path is required' } };
  return { status: 200, body: detectProject(dir) };
}

async function invokeFunction(input) {
  const { functionId } = input || {};
  const fn = store.get(functionId);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  if (inFlight.has(fn.id)) {
    return { status: 409, body: { error: 'an invoke is already in flight for this function' } };
  }
  inFlight.add(fn.id);
  try {
    // Local services (e.g. MinIO): enabled services must be running; their
    // env sits below the .env file and UI vars so user overrides win.
    // playground.json (re-read fresh) is authoritative over manual toggles.
    const enabledServices = effectiveServices(fn);
    const serviceErr = unknownServiceError(enabledServices);
    if (serviceErr) return { status: 400, body: { error: serviceErr } };
    if (enabledServices.length > 0) {
      // One probe for every enabled service — this runs before each invoke,
      // so a per-service docker round trip here is latency on every run.
      const states = await localServices.statusAll().catch(() => null);
      const notRunning = enabledServices.find(name => states?.get(name) !== 'running');
      if (notRunning) {
        const result = {
          ok: false,
          phase: 'service',
          error: {
            type: 'Service.NotRunning',
            message: `${localServices.labelFor(notRunning)} is not running — start it from the Local services menu or disable it for this function`,
            stackTrace: [],
          },
          logs: '',
          report: { requestId: crypto.randomUUID(), durationMs: 0, billedMs: 0,
            memoryMb: input.memoryMb ?? fn.memoryMb, timedOut: false },
        };
        try {
          history.append(fn.id, {
            handler: input.handler ?? fn.handler, event: input.event ?? {},
            response: undefined, error: result.error, logs: '',
            report: result.report, durationMs: 0, ok: false,
          });
        } catch {}
        return { status: 200, body: result };
      }
    }
    const serviceEnv = localServices.composeEnv(enabledServices);

    let result;
    let buildInfo = null;
    if (fn.buildCommand) {
      buildInfo = await runBuild({ dir: fn.path, command: fn.buildCommand });
    }
    if (buildInfo && !buildInfo.ok) {
      result = {
        ok: false,
        phase: 'build',
        error: {
          type: 'Build.Failed',
          message: `Build command failed (exit ${buildInfo.exitCode ?? 'n/a'}): ${fn.buildCommand}`,
          stackTrace: [],
        },
        logs: buildInfo.output,
        report: { requestId: crypto.randomUUID(), durationMs: 0, billedMs: 0,
          memoryMb: input.memoryMb ?? fn.memoryMb, timedOut: false,
          buildMs: buildInfo.durationMs },
      };
    } else {
      result = await invoke({
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
        env: {
          ...serviceEnv,
          ...envfile.resolve(fn.path, input.envFile ?? fn.envFile ?? 'auto'),
          ...fn.env,
          ...(input.envVars || {}),
        },
        timeoutMs: input.timeoutMs ?? fn.timeoutMs,
        memoryMb: input.memoryMb ?? fn.memoryMb,
        jarPath: fn.jarPath || findJar(fn.path),
      });
      if (buildInfo) {
        result.logs = `=== build ===\n${buildInfo.output}\n=== invoke ===\n${result.logs}`;
        result.report.buildMs = buildInfo.durationMs;
      }
    }
    try {
      history.append(fn.id, {
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
        response: result.response,
        error: result.error ?? null,
        logs: result.logs,
        report: result.report,
        durationMs: result.report.durationMs,
        ok: result.ok,
      });
    } catch (err) {
      console.warn(`aws-playground: failed to record invoke history: ${err.message}`);
    }
    return { status: 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    inFlight.delete(fn.id);
  }
}

function effectiveServices(fn) {
  return projectconfig.read(fn.path).services ?? fn.localServices ?? [];
}

// fn.localServices (and playground.json's services list) are never validated
// against the service registry when they're written, so a stale/typo'd name
// can reach localServices' internals, which throw for anything unregistered.
// Catch that here with the same clean 400 the rest of the API gives instead
// of letting it surface as an unhandled rejection / opaque 500.
function unknownServiceError(names) {
  const known = localServices.names();
  const unknown = names.find(name => !known.includes(name));
  return unknown ? `unknown service '${unknown}' configured for this function` : null;
}

async function setSelection(input) {
  const { functionId } = input || {};
  if (functionId === null || functionId === undefined) {
    return { status: 200,
      body: await localServices.setSelection([], selectionOpts(input)) };
  }
  const fn = store.get(functionId);
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  const services = effectiveServices(fn);
  const err = unknownServiceError(services);
  if (err) return { status: 400, body: { error: err } };
  return { status: 200,
    body: await localServices.setSelection(services, selectionOpts(input)) };
}

function selectionOpts(input) {
  // waitReady:false is a test affordance; the UI never sends it.
  return input?.waitReady === false ? { waitReady: false } : {};
}

async function listServices() {
  return { status: 200, body: await localServices.list() };
}

async function startService(name, opts) {
  if (!localServices.names().includes(name)) {
    return { status: 404, body: { error: `unknown service '${name}'` } };
  }
  const r = await localServices.start(name, opts);
  if (!r.ok) return { status: 409, body: { error: r.output, state: r.state } };
  return { status: 200, body: { state: r.state } };
}

async function stopService(name) {
  if (!localServices.names().includes(name)) {
    return { status: 404, body: { error: `unknown service '${name}'` } };
  }
  const r = await localServices.stop(name);
  if (!r.ok) return { status: 409, body: { error: r.output, state: r.state } };
  return { status: 200, body: { state: r.state } };
}

function listHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: { entries: history.list(functionId) } };
}

function clearHistory(functionId) {
  if (!store.get(functionId)) return { status: 404, body: { error: 'function not found' } };
  history.clear(functionId);
  return { status: 204 };
}

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory,
  listServices, startService, stopService, setSelection, RUNTIMES };
