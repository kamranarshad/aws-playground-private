const { execFile } = require('child_process');
const net = require('net');

// Local AWS-equivalent services, one docker image per service. Strictly
// opt-in: docker is only touched by explicit start/stop/status calls.
// AWS_PLAYGROUND_DOCKER overrides the docker binary (used by tests).
// kind 'aws' = speaks an AWS API (participates in AWS_ENDPOINT_URL*
// composition); 'plain' = ordinary endpoint (redis, postgres).
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

async function dockerAvailable() {
  return (await docker(['info'])).code === 0;
}

async function status(name) {
  const svc = entry(name);
  const r = await docker(['inspect', '--format', '{{.State.Running}}', svc.container]);
  if (r.code !== 0) return 'absent';
  return r.output.includes('true') ? 'running' : 'stopped';
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

async function start(name, { waitReady: wait = true } = {}) {
  const svc = entry(name);
  const state = await status(name);
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
  const r = await docker(['stop', svc.container], 30000);
  if (r.code !== 0) return { ok: false, state: await status(name), output: r.output };
  return { ok: true, state: 'stopped', output: '' };
}

async function list() {
  const available = await dockerAvailable();
  const services = await Promise.all(Object.entries(REGISTRY).map(async ([name, svc]) => ({
    name,
    label: svc.label,
    shortLabel: svc.shortLabel,
    note: svc.note ?? null,
    state: available ? await status(name) : 'unavailable',
    endpoint: svc.endpoint,
    consoleUrl: svc.consoleUrl,
  })));
  return { docker: { available }, services };
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

module.exports = { dockerAvailable, status, start, stop, list, envFor,
  composeEnv, names };
