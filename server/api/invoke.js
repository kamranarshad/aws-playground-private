const crypto = require('crypto');
const store = require('../store');
const { findJar } = require('../detect');
const envfile = require('../envfile');
const localServices = require('../services');
const { runBuild } = require('../build');
const { invoke } = require('../invoker');
const history = require('../history');
const inFlight = require('./in-flight');
const { effectiveServices, unknownServiceError } = require('./services');

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
          ...input.envVars,
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

module.exports = { invokeFunction };
