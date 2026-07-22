const { execFile } = require('child_process');

// Local AWS-equivalent services, one docker image per service. Strictly
// opt-in: docker is only touched by explicit start/stop/status calls.
// AWS_PLAYGROUND_DOCKER overrides the docker binary (used by tests).
const REGISTRY = {
  minio: {
    label: 'S3 (MinIO)',
    image: 'minio/minio',
    container: 'aws-playground-minio',
    volume: 'aws-playground-minio-data',
    runArgs: [
      '-v', 'aws-playground-minio-data:/data',
      '-p', '127.0.0.1:9400:9000',
      '-p', '127.0.0.1:9401:9001',
      '-e', 'MINIO_ROOT_USER=playground',
      '-e', 'MINIO_ROOT_PASSWORD=playground123',
      'minio/minio', 'server', '/data', '--console-address', ':9001',
    ],
    readyUrl: 'http://127.0.0.1:9400/minio/health/live',
    endpoint: 'http://127.0.0.1:9400',
    consoleUrl: 'http://127.0.0.1:9401',
    env: {
      AWS_ENDPOINT_URL: 'http://127.0.0.1:9400',
      AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9400',
      AWS_ACCESS_KEY_ID: 'playground',
      AWS_SECRET_ACCESS_KEY: 'playground123',
    },
  },
};

function dockerBin() {
  return process.env.AWS_PLAYGROUND_DOCKER || 'docker';
}

function docker(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(dockerBin(), args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      });
    });
  });
}

function entry(name) {
  const svc = REGISTRY[name];
  if (!svc) throw new Error(`unknown service '${name}'`);
  return svc;
}

async function dockerAvailable() {
  return (await docker(['info'])).code === 0;
}

async function status(name) {
  const svc = entry(name);
  const r = await docker(['inspect', '--format', '{{.State.Running}}', svc.container]);
  if (r.code !== 0) return 'absent';
  return r.output.includes('true') ? 'running' : 'stopped';
}

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function start(name, { waitReady: wait = true } = {}) {
  const svc = entry(name);
  const state = await status(name);
  if (state !== 'running') {
    const r = state === 'stopped'
      ? await docker(['start', svc.container])
      : await docker(['run', '-d', '--name', svc.container, ...svc.runArgs], 120000);
    if (r.code !== 0) return { ok: false, state, output: r.output };
  }
  if (wait && !(await waitReady(svc.readyUrl))) {
    return { ok: false, state: 'running',
      output: `container started but ${svc.readyUrl} did not become ready` };
  }
  return { ok: true, state: 'running', output: '' };
}

async function stop(name) {
  const svc = entry(name);
  const r = await docker(['stop', svc.container], 30000);
  if (r.code !== 0) return { ok: false, state: await status(name), output: r.output };
  return { ok: true, state: 'stopped', output: '' };
}

async function list() {
  const available = await dockerAvailable();
  const services = await Promise.all(Object.entries(REGISTRY).map(async ([name, svc]) => ({
    name,
    label: svc.label,
    state: available ? await status(name) : 'unavailable',
    endpoint: svc.endpoint,
    consoleUrl: svc.consoleUrl,
  })));
  return { docker: { available }, services };
}

function envFor(name) {
  return { ...entry(name).env };
}

function names() {
  return Object.keys(REGISTRY);
}

module.exports = { dockerAvailable, status, start, stop, list, envFor, names };
