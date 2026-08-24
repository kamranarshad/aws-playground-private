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

function entry(name) {
  const svc = REGISTRY[name];
  if (!svc) throw new Error(`unknown service '${name}'`);
  return svc;
}

function names() {
  return Object.keys(REGISTRY);
}

// Display name without touching docker — for error messages that already
// know the service is unreachable.
function labelFor(name) {
  return entry(name).label;
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

module.exports = { REGISTRY, entry, names, labelFor, envFor, composeEnv };
