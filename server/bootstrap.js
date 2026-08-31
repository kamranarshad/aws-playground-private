const defaultTriggerManager = require('./trigger/manager');
const defaultS3Trigger = require('./trigger/s3');
const defaultLocalServices = require('./services');
const { invokeFunction: defaultInvokeFunction } = require('./api/invoke');

// Everything that has to happen for the playground to be *running* rather
// than merely serving HTTP: triggers resumed, the S3 webhook listener bound,
// and a teardown that leaves the machine as we found it.
//
// This lives here rather than in bin/cli.js because the vite dev server is a
// second, equally real entry point. With this wiring stranded in the CLI,
// `npm run dev` served a working UI whose triggers never fired -- so trigger
// work could not be developed against the dev server at all.
let started = false;
let listener = null;
let deps = null;

async function start(overrides = {}) {
  if (started) return;
  started = true;
  deps = {
    triggerManager: overrides.triggerManager ?? defaultTriggerManager,
    s3Trigger: overrides.s3Trigger ?? defaultS3Trigger,
    localServices: overrides.localServices ?? defaultLocalServices,
    invokeFunction: overrides.invokeFunction ?? defaultInvokeFunction,
  };

  await deps.triggerManager.resumeAll({ invokeFunction: deps.invokeFunction }).catch((err) => {
    console.warn(`aws-playground: could not resume triggers: ${err.message}`);
  });

  try {
    listener = await deps.s3Trigger.createListener({
      routesFor: deps.triggerManager.s3RoutesFor,
      invokeFunction: deps.invokeFunction,
    });
  } catch (err) {
    console.warn(`aws-playground: could not start the S3 trigger listener: ${err.message}`);
    // Without this every function with an S3 trigger keeps showing
    // 'listening' in the UI even though no event can ever reach it.
    deps.triggerManager.setS3ListenerError(err);
  }
}

async function stop() {
  if (!started) return [];
  started = false;
  deps.triggerManager.stopAll();
  try { listener?.stop?.(); } catch {}
  listener = null;
  try {
    return await deps.localServices.stopAutoStarted();
  } catch (err) {
    console.warn(`aws-playground: could not stop auto-started services: ${err.message}`);
    return [];
  }
}

module.exports = { start, stop };
