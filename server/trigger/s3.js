const { S3Client, CreateBucketCommand, PutBucketNotificationConfigurationCommand } = require('@aws-sdk/client-s3');
const { entry, AWS_DUMMY_CREDS } = require('../services/registry');

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

module.exports = {
  categoryFor, normalizeRecord, dispatch,
  buildClient, ensureBucket, syncBucketNotification, ensureBucketConfig,
  NOTIFICATION_ID, NOTIFICATION_ARN,
};
