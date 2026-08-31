const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-boot-'));
const bootstrap = require('../../server/bootstrap');

function fakeDeps(over = {}) {
  return {
    triggerManager: {
      resumeAll: async () => {},
      stopAll: () => {},
      s3RoutesFor: () => [],
      setS3ListenerError: () => {},
      ...over.triggerManager,
    },
    s3Trigger: { createListener: async () => ({ stop: () => {} }), ...over.s3Trigger },
    localServices: { stopAutoStarted: async () => [], ...over.localServices },
    pool: { shutdown: async () => {}, ...over.pool },
    invokeFunction: async () => ({ status: 200, body: {} }),
  };
}

test('start is idempotent — a second call does not resume triggers twice', async () => {
  let resumes = 0;
  const deps = fakeDeps({ triggerManager: { resumeAll: async () => { resumes++; } } });
  await bootstrap.start(deps);
  await bootstrap.start(deps);
  assert.strictEqual(resumes, 1);
  await bootstrap.stop();
});

test('a failing S3 listener is reported to the trigger manager, not thrown', async () => {
  let reported = null;
  await bootstrap.start(fakeDeps({
    triggerManager: { setS3ListenerError: (err) => { reported = err; } },
    s3Trigger: { createListener: async () => { throw new Error('port taken'); } },
  }));
  assert.strictEqual(reported.message, 'port taken');
  await bootstrap.stop();
});

test('stop returns the auto-started services it stopped, and closes the listener', async () => {
  let closed = false;
  await bootstrap.start(fakeDeps({
    s3Trigger: { createListener: async () => ({ stop: () => { closed = true; } }) },
    localServices: { stopAutoStarted: async () => ['minio'] },
  }));
  assert.deepStrictEqual(await bootstrap.stop(), ['minio']);
  assert.strictEqual(closed, true, 'the S3 listener was left running');
});

test('stop on a bootstrap that never started is a no-op', async () => {
  assert.deepStrictEqual(await bootstrap.stop(), []);
});

test('a resumeAll failure does not prevent the listener from binding', async () => {
  let listenerStarted = false;
  await bootstrap.start(fakeDeps({
    triggerManager: { resumeAll: async () => { throw new Error('registry unreadable'); } },
    s3Trigger: { createListener: async () => { listenerStarted = true; return { stop: () => {} }; } },
  }));
  assert.strictEqual(listenerStarted, true);
  await bootstrap.stop();
});

test('stop shuts the warm environment pool down', async () => {
  let shutdowns = 0;
  await bootstrap.start(fakeDeps({ pool: { shutdown: async () => { shutdowns++; } } }));
  await bootstrap.stop();
  assert.strictEqual(shutdowns, 1, 'warm handler processes were left running');
});
