const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject } = require('./detect');
const { findJar } = require('./detect');
const envfile = require('./envfile');
const { runBuild } = require('./build');
const { invoke } = require('./invoker');
const history = require('./history');

const RUNTIMES = ['python', 'node', 'java'];
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
  const [python, node, java] = await Promise.all([
    checkRuntime('python3', ['--version']),
    checkRuntime('node', ['--version']),
    checkRuntime('java', ['-version']),
  ]);
  return { status: 200, body: { runtimes: { python, node, java } } };
}

function listFunctions() {
  return { status: 200, body: { functions: store.list() } };
}

function createFunction(input) {
  const { name, path: dir, runtime } = input || {};
  if (!name || !dir || !runtime) {
    return { status: 400, body: { error: 'name, path and runtime are required' } };
  }
  if (!RUNTIMES.includes(runtime)) {
    return { status: 400, body: { error: `unsupported runtime '${runtime}'` } };
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { status: 400, body: { error: `path is not a directory: ${dir}` } };
  }
  return { status: 201, body: store.create(input) };
}

function updateFunction(id, patch) {
  const fn = store.update(id, patch || {});
  if (!fn) return { status: 404, body: { error: 'function not found' } };
  return { status: 200, body: fn };
}

function deleteFunction(id) {
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
        report: { requestId: '', durationMs: 0, billedMs: 0,
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
  deleteFunction, detect, invokeFunction, listHistory, clearHistory, RUNTIMES };
