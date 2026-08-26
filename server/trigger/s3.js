const http = require('http');
const { S3Client, CreateBucketCommand, PutBucketNotificationConfigurationCommand } = require('@aws-sdk/client-s3');
const { entry, AWS_DUMMY_CREDS } = require('../services/registry');

const PORT = 9501;
const HOST = '127.0.0.1';

const NOTIFICATION_ID = 'PLAYGROUND';
const NOTIFICATION_ARN = `arn:minio:sqs::${NOTIFICATION_ID}:webhook`;

function categoryFor(eventName) {
  if (typeof eventName !== 'string') return null;
  if (eventName.startsWith('s3:ObjectCreated:')) return 'ObjectCreated';
  if (eventName.startsWith('s3:ObjectRemoved:')) return 'ObjectRemoved';
  return null;
}

// MinIO's webhook payload is structurally close to a real S3 event
// notification but tags itself as the sender — normalized here so a
// fixture written against a standard S3Event/Records shape needs no
// MinIO-specific branching.
function normalizeRecord(record) {
  return { ...record, eventSource: 'aws:s3' };
}

function matchesRoute(route, category, key) {
  if (!route.events.includes(category)) return false;
  if (route.prefix && !key.startsWith(route.prefix)) return false;
  if (route.suffix && !key.endsWith(route.suffix)) return false;
  return true;
}

// Fire-and-forget by design: MinIO doesn't wait on Lambda's result (see
// server/trigger/http.js's request handler for the contrasting synchronous
// case), so a rejected invoke is swallowed rather than surfaced anywhere —
// there's no caller left to report it to.
function dispatch(raw, { routesFor, invokeFunction }) {
  const bucket = raw.s3?.bucket?.name;
  const key = raw.s3?.object?.key;
  const category = categoryFor(raw.eventName);
  if (!bucket || !key || !category) return;
  const record = normalizeRecord(raw);
  for (const route of routesFor(bucket)) {
    if (!matchesRoute(route, category, key)) continue;
    invokeFunction({
      functionId: route.functionId,
      event: { Records: [record] },
      source: { type: 'trigger', bucket, key, eventName: raw.eventName },
    }).catch(() => {});
  }
}

function buildClient() {
  const svc = entry('minio');
  return new S3Client({
    endpoint: svc.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: AWS_DUMMY_CREDS.AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_DUMMY_CREDS.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  }
}

async function syncBucketNotification(client, bucket, hasWatchers) {
  await client.send(new PutBucketNotificationConfigurationCommand({
    Bucket: bucket,
    NotificationConfiguration: {
      QueueConfigurations: hasWatchers ? [{
        Id: NOTIFICATION_ID,
        QueueArn: NOTIFICATION_ARN,
        Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
      }] : [],
    },
  }));
}

// The single entry point the trigger manager calls: creates the bucket (only
// worth doing when something is about to watch it) and always brings its
// notification config in line with whether anything watches it now.
async function ensureBucketConfig(bucket, hasWatchers) {
  const client = buildClient();
  if (hasWatchers) await ensureBucket(client, bucket);
  await syncBucketNotification(client, bucket, hasWatchers);
}

function createRequestHandler({ routesFor, invokeFunction }) {
  return async function handleRequest(req, res) {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Always 200 once the body is read — MinIO doesn't wait on the actual
    // invoke outcome (see dispatch's fire-and-forget invokeFunction call),
    // and a malformed body is our problem to log, not MinIO's to retry.
    res.writeHead(200);
    res.end();
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return;
    }
    for (const record of payload.Records ?? []) {
      dispatch(record, { routesFor, invokeFunction });
    }
  };
}

// Stateless factory — one shared instance is started once from bin/cli.js
// for the life of the process (unlike server/trigger/http.js's listener,
// which the trigger manager starts/stops based on trigger state), so it
// needs no singleton bookkeeping here.
function createListener({ routesFor, invokeFunction, port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler({ routesFor, invokeFunction }));
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ server, stop: () => server.close() });
    });
  });
}

module.exports = {
  categoryFor, normalizeRecord, dispatch,
  buildClient, ensureBucket, syncBucketNotification, ensureBucketConfig,
  NOTIFICATION_ID, NOTIFICATION_ARN,
  PORT, HOST, createRequestHandler, createListener,
};
