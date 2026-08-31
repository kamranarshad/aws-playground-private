const store = require('../persistence/store');
const { findJar } = require('../runtime/detect');
const envfile = require('../runtime/envfile');
const localServices = require('../services');
const { runBuild } = require('../runtime/build');
const { invoke } = require('../runtime/invoker');
const pool = require('../runtime/pool');
const history = require('../persistence/history');
const inFlight = require('./in-flight');
const { effectiveServices, unknownServiceError } = require('./services');
const { failureResult } = require('./invoke-result');

async function invokeFunction(input) {
  const { functionId, source } = input || {};
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
        const result = failureResult({
          phase: 'service',
          type: 'Service.NotRunning',
          message: `${localServices.labelFor(notRunning)} is not running — start it from the Local services menu or disable it for this function`,
          memoryMb: input.memoryMb ?? fn.memoryMb,
        });
        try {
          history.append(fn.id, {
            handler: input.handler ?? fn.handler, event: input.event ?? {},
            response: undefined, error: result.error, logs: '',
            report: result.report, durationMs: 0, ok: false,
            source: source ?? { type: 'manual' },
          });
        } catch {}
        return { status: 200, body: result };
      }
    }
    const serviceEnv = localServices.composeEnv(enabledServices);

    /** @type {import('../types').InvokeOutcome} */
    let result;
    let buildInfo = null;
    if (fn.buildCommand) {
      buildInfo = await runBuild({ dir: fn.path, command: fn.buildCommand });
      // A build by definition changed the artifacts a warm environment loaded.
      pool.evictForFunction(fn.id);
    }
    if (buildInfo && !buildInfo.ok) {
      result = failureResult({
        phase: 'build',
        type: 'Build.Failed',
        message: `Build command failed (exit ${buildInfo.exitCode ?? 'n/a'}): ${fn.buildCommand}`,
        memoryMb: input.memoryMb ?? fn.memoryMb,
        logs: buildInfo.output,
        report: { buildMs: buildInfo.durationMs },
      });
    } else {
      result = await invoke({
        id: fn.id,
        autoTrace: fn.autoTrace,
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: input.handler ?? fn.handler,
        event: input.event ?? {},
        env: {
          ...serviceEnv,
          ...envfile.resolve(fn.path, input.envFile ?? fn.envFile ?? 'auto'),
          ...fn.env,
          ...input.envVars,
        },
        timeoutMs: input.timeoutMs ?? fn.timeoutMs,
        memoryMb: input.memoryMb ?? fn.memoryMb,
        forceCold: input.forceCold === true,
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
        trace: result.trace ?? null,
        durationMs: result.report.durationMs,
        ok: result.ok,
        source: source ?? { type: 'manual' },
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

module.exports = { invokeFunction };
