const { execFile } = require('child_process');
const net = require('net');

// Local AWS-equivalent services, one docker image per service. Strictly
// opt-in: docker is only touched by explicit start/stop/status calls.
// AWS_PLAYGROUND_DOCKER overrides the docker binary (used by tests).
// kind 'aws' = speaks an AWS API (participates in AWS_ENDPOINT_URL*
// composition); 'plain' = ordinary endpoint (redis, postgres).
// The AWS-API services share the dummy access/secret the playground
// injects — the same values you type into a console or client.
const AWS_CREDENTIALS = [
  { label: 'Access key', value: 'playground' },
  { label: 'Secret key', value: 'playground123' },
];

const REGISTRY = {
  minio: {
    label: 'S3 (MinIO)',
    shortLabel: 'S3',
    kind: 'aws',
    image: 'minio/minio',
    container: 'aws-playground-minio',
    runArgs: [
      '-v', 'aws-playground-minio-data:/data',
      '-p', '127.0.0.1:9400:9000',
      '-p', '127.0.0.1:9401:9001',
      '-e', 'MINIO_ROOT_USER=playground',
      '-e', 'MINIO_ROOT_PASSWORD=playground123',
      'minio/minio', 'server', '/data', '--console-address', ':9001',
    ],
    ready: { type: 'http', target: 'http://127.0.0.1:9400/minio/health/live' },
    endpoint: 'http://127.0.0.1:9400',
    consoleUrl: 'http://127.0.0.1:9401',
    env: { AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9400' },
    credentials: AWS_CREDENTIALS,
  },
  elasticmq: {
    label: 'SQS (ElasticMQ)',
    shortLabel: 'SQS',
    kind: 'aws',
    image: 'softwaremill/elasticmq-native',
    container: 'aws-playground-elasticmq',
    note: 'queues are ephemeral — recreated on restart',
    runArgs: [
      '-p', '127.0.0.1:9324:9324',
      '-p', '127.0.0.1:9325:9325',
      'softwaremill/elasticmq-native',
    ],
    ready: { type: 'http', target: 'http://127.0.0.1:9324/' },
    endpoint: 'http://127.0.0.1:9324',
    consoleUrl: 'http://127.0.0.1:9325',
    env: { AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:9324' },
    credentials: AWS_CREDENTIALS,
  },
  dynamodb: {
    label: 'DynamoDB (Local)',
    shortLabel: 'DynamoDB',
    kind: 'aws',
    image: 'amazon/dynamodb-local',
    container: 'aws-playground-dynamodb',
    runArgs: [
      '-v', 'aws-playground-dynamodb-data:/home/dynamodblocal/data',
      '-p', '127.0.0.1:9402:8000',
      'amazon/dynamodb-local',
      '-jar', 'DynamoDBLocal.jar', '-sharedDb', '-dbPath', '/home/dynamodblocal/data',
    ],
    ready: { type: 'http', target: 'http://127.0.0.1:9402/' },
    endpoint: 'http://127.0.0.1:9402',
    consoleUrl: null,
    env: { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:9402' },
    credentials: AWS_CREDENTIALS,
  },
  redis: {
    label: 'ElastiCache (Redis)',
    shortLabel: 'Redis',
    kind: 'plain',
    image: 'redis:alpine',
    container: 'aws-playground-redis',
    runArgs: [
      '-v', 'aws-playground-redis-data:/data',
      '-p', '127.0.0.1:9403:6379',
      'redis:alpine', 'redis-server', '--appendonly', 'yes',
    ],
    ready: { type: 'tcp', target: '127.0.0.1:9403' },
    endpoint: 'redis://127.0.0.1:9403',
    consoleUrl: null,
    env: { REDIS_URL: 'redis://127.0.0.1:9403' },
    credentials: [],
  },
  postgres: {
    label: 'RDS (PostgreSQL)',
    shortLabel: 'Postgres',
    kind: 'plain',
    image: 'postgres:alpine',
    container: 'aws-playground-postgres',
    runArgs: [
      '-v', 'aws-playground-postgres-data:/var/lib/postgresql',
      '-p', '127.0.0.1:9404:5432',
      '-e', 'POSTGRES_USER=playground',
      '-e', 'POSTGRES_PASSWORD=playground123',
      '-e', 'POSTGRES_DB=playground',
      'postgres:alpine',
    ],
    ready: { type: 'tcp', target: '127.0.0.1:9404' },
    endpoint: 'postgresql://127.0.0.1:9404',
    consoleUrl: null,
    env: {
      DATABASE_URL: 'postgresql://playground:playground123@127.0.0.1:9404/playground',
      PGHOST: '127.0.0.1',
      PGPORT: '9404',
      PGUSER: 'playground',
      PGPASSWORD: 'playground123',
      PGDATABASE: 'playground',
    },
    credentials: [
      { label: 'User', value: 'playground' },
      { label: 'Password', value: 'playground123' },
      { label: 'Database', value: 'playground' },
    ],
  },
};

const AWS_DUMMY_CREDS = {
  AWS_ACCESS_KEY_ID: 'playground',
  AWS_SECRET_ACCESS_KEY: 'playground123',
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

async function status(name) {
  const svc = entry(name);
  const r = await docker(['inspect', '--format', '{{.State.Running}}', svc.container]);
  if (r.code !== 0) return 'absent';
  return r.output.includes('true') ? 'running' : 'stopped';
}

// Every service's state from one `docker ps -a`, which also doubles as the
// daemon liveness check (it fails exactly when `docker info` would).
// Returns null when docker is unavailable. Callers that poll — the services
// list, selection sync — use this instead of `docker info` plus one
// `docker inspect` per service, which was six process spawns per poll.
async function statusAll() {
  const r = await docker(['ps', '-a', '--format', '{{.Names}} {{.State}}']);
  if (r.code !== 0) return null;
  const byContainer = new Map();
  for (const line of r.output.split('\n')) {
    const [container, state] = line.trim().split(/\s+/);
    // docker's State is running/exited/created/paused/restarting/dead;
    // everything that isn't running is 'stopped', as `docker inspect
    // {{.State.Running}}` reported it before.
    if (container) byContainer.set(container, state === 'running' ? 'running' : 'stopped');
  }
  const states = new Map();
  for (const [name, svc] of Object.entries(REGISTRY)) {
    states.set(name, byContainer.get(svc.container) ?? 'absent');
  }
  return states;
}

function tcpReachable(target) {
  const [host, port] = target.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function waitReady(ready, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready.type === 'tcp') {
      if (await tcpReachable(ready.target)) return true;
    } else {
      // Any HTTP response counts: DynamoDB Local answers GET / with 400.
      try {
        await fetch(ready.target);
        return true;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// knownState lets a caller that just probed docker (setSelection) skip a
// second probe for the same container. Omit it and start() checks itself.
async function start(name, { waitReady: wait = true, auto = false, knownState } = {}) {
  const svc = entry(name);
  // Any explicit (non-auto) start promotes the service to user-managed:
  // it will never be auto-stopped by selection changes.
  if (!auto) {
    autoStarted.delete(name);
    cancelStop(name);
  }
  const state = knownState ?? await status(name);
  if (state !== 'running') {
    const r = state === 'stopped'
      ? await docker(['start', svc.container])
      : await docker(['run', '-d', '--name', svc.container, ...svc.runArgs], 120000);
    if (r.code !== 0) return { ok: false, state, output: r.output };
  }
  if (wait && !(await waitReady(svc.ready))) {
    return { ok: false, state: 'running',
      output: `container started but ${svc.ready.target} did not become ready` };
  }
  return { ok: true, state: 'running', output: '' };
}

async function stop(name) {
  const svc = entry(name);
  autoStarted.delete(name);
  cancelStop(name);
  const r = await docker(['stop', svc.container], 30000);
  if (r.code !== 0) return { ok: false, state: await status(name), output: r.output };
  return { ok: true, state: 'stopped', output: '' };
}

// --- selection-driven lifecycle -------------------------------------------
// Services started because a selected function's playground.json declared
// them ("auto") stop GRACE_MS after no selection needs them. User-started
// services are never touched.
function graceMs() {
  return parseInt(process.env.AWS_PLAYGROUND_SERVICE_GRACE_MS || '15000', 10);
}

const autoStarted = new Set();
const stopTimers = new Map();

function cancelStop(name) {
  const t = stopTimers.get(name);
  if (t) {
    clearTimeout(t);
    stopTimers.delete(name);
  }
}

async function setSelection(needed, { waitReady: wait = true } = {}) {
  const need = new Set(needed);
  const started = [];
  const scheduledStop = [];

  for (const name of need) entry(name); // validate before touching docker
  // Cancel pending stops before the first await. Docker can be slow (or hung),
  // and a grace timer coming due mid-probe would otherwise stop a service that
  // has just been selected again.
  for (const name of need) cancelStop(name);
  // One probe for the whole selection instead of one per declared service.
  const states = need.size > 0 ? await statusAll() : null;

  for (const name of need) {
    const state = states?.get(name);
    if (state !== 'running') {
      const r = await start(name, { waitReady: wait, auto: true, knownState: state });
      if (r.ok) {
        autoStarted.add(name);
        started.push(name);
      }
    }
  }

  for (const name of [...autoStarted]) {
    if (need.has(name) || stopTimers.has(name)) continue;
    scheduledStop.push(name);
    stopTimers.set(name, setTimeout(() => {
      stopTimers.delete(name);
      // Re-check membership: a manual start/stop may have promoted or
      // cleared it while the timer was pending.
      if (!autoStarted.has(name)) return;
      autoStarted.delete(name);
      stop(name).catch(() => {});
    }, graceMs()));
  }

  return { started, scheduledStop };
}

// Shutdown sweep: leave the machine as we found it. Only services the
// playground auto-started are stopped — anything started by hand in the
// UI (or already running before we looked) keeps running.
async function stopAutoStarted() {
  const pending = [...autoStarted];
  for (const name of pending) cancelStop(name);
  autoStarted.clear();
  const stopped = [];
  for (const name of pending) {
    const r = await stop(name).catch(() => ({ ok: false }));
    if (r.ok) stopped.push(name);
  }
  return stopped;
}

async function list() {
  const states = await statusAll();
  const services = Object.entries(REGISTRY).map(([name, svc]) => ({
    name,
    label: svc.label,
    shortLabel: svc.shortLabel,
    note: svc.note ?? null,
    state: states ? states.get(name) : 'unavailable',
    endpoint: svc.endpoint,
    consoleUrl: svc.consoleUrl,
    credentials: svc.credentials ?? [],
  }));
  return { docker: { available: states !== null }, services };
}

function envFor(name) {
  return { ...entry(name).env };
}

// Composition across enabled services: per-service vars always; dummy AWS
// creds when any AWS-API service is present; the global AWS_ENDPOINT_URL
// only when exactly one AWS-API service is enabled (two or more would
// misroute whichever APIs the global var covers).
function composeEnv(names) {
  const env = {};
  const awsServices = [];
  for (const name of names) {
    const svc = entry(name);
    Object.assign(env, svc.env);
    if (svc.kind === 'aws') awsServices.push(svc);
  }
  if (awsServices.length > 0) Object.assign(env, AWS_DUMMY_CREDS);
  if (awsServices.length === 1) env.AWS_ENDPOINT_URL = awsServices[0].endpoint;
  return env;
}

function names() {
  return Object.keys(REGISTRY);
}

// Display name without touching docker — for error messages that already
// know the service is unreachable.
function labelFor(name) {
  return entry(name).label;
}

module.exports = { status, statusAll, start, stop, list, envFor,
  composeEnv, names, labelFor, setSelection, stopAutoStarted };
