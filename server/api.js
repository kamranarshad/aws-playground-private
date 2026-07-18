const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject } = require('./detect');
const { findJar } = require('./detect');
const { invoke } = require('./invoker');

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
    const result = await invoke({
      name: fn.name,
      dir: fn.path,
      runtime: fn.runtime,
      handler: input.handler ?? fn.handler,
      event: input.event ?? {},
      env: { ...fn.env, ...(input.envVars || {}) },
      timeoutMs: input.timeoutMs ?? fn.timeoutMs,
      memoryMb: input.memoryMb ?? fn.memoryMb,
      jarPath: fn.jarPath || findJar(fn.path),
    });
    return { status: 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    inFlight.delete(fn.id);
  }
}

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, RUNTIMES };
