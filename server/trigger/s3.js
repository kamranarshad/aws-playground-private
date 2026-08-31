const http = require('http');
const { requireOptional } = require('../optional-deps');
const { entry, AWS_DUMMY_CREDS } = require('../services/registry');

const PORT = 9501;
const HOST = '127.0.0.1';

const S3_MISSING_MESSAGE =
  'S3 triggers need `@aws-sdk/client-s3`; run `npm i @aws-sdk/client-s3` to enable them.';

// @aws-sdk/client-s3 is an optionalDependency -- loaded on first use, so the
// process-lifetime webhook listener below (createListener, which never
// touches the SDK) still starts fine without it.
let _s3Sdk;
function s3Sdk() {
  if (!_s3Sdk) _s3Sdk = requireOptional('@aws-sdk/client-s3', S3_MISSING_MESSAGE);
  return _s3Sdk;
}

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

// MinIO (like real S3) form-URL-encodes the object key inside the
// notification payload — e.g. a real key of "images/pic.png" arrives here
// as "images%2Fpic.png" — so a raw-key comparison against a plain prefix
// like "images/" would never match. That encoding also writes a literal
// space as "+" (and a literal "+" as "%2B"), so "+" is turned back into a
// space *before* percent-decoding — otherwise a key of "my file.txt"
// arrives as "my+file.txt" and a prefix filter of "my " silently never
// matches. Decoded once here purely for our own routing/matching/display
// purposes; a malformed percent-sequence falls back to the raw value rather
// than throwing, since createRequestHandler's caller only wraps dispatch()
// as a whole, not this specific step.
function decodeKey(rawKey) {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, '%20'));
  } catch {
    return rawKey;
  }
}

// Fire-and-forget by design: MinIO doesn't wait on Lambda's result (see
// server/trigger/http.js's request handler for the contrasting synchronous
// case), so a rejected invoke is swallowed rather than surfaced anywhere —
// there's no caller left to report it to.
function dispatch(raw, { routesFor, invokeFunction }) {
  const bucket = raw.s3?.bucket?.name;
  const rawKey = raw.s3?.object?.key;
  const key = typeof rawKey === 'string' ? decodeKey(rawKey) : rawKey;
  const category = categoryFor(raw.eventName);
  if (!bucket || !key || !category) return;
  // The Records payload handed to the invoked function keeps the raw
  // (still percent-encoded) key from MinIO/S3 untouched — matching real
  // AWS, where a real S3-triggered Lambda receives event.Records[].s3.object.key
  // percent-encoded and is expected to decode it itself. Only the decoded
  // `key` above (used for route matching and the `source` field below,
  // which the trigger status/history UI reads) is normalized.
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
  const { S3Client } = s3Sdk();
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
  const { CreateBucketCommand } = s3Sdk();
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  }
}

async function syncBucketNotification(client, bucket, hasWatchers) {
  const { PutBucketNotificationConfigurationCommand } = s3Sdk();
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
    const records = Array.isArray(payload.Records) ? payload.Records : [];
    for (const record of records) {
      try {
        dispatch(record, { routesFor, invokeFunction });
      } catch {
        // Silently drop records that cause dispatch to fail — this fire-and-forget
        // listener must never crash the process or reject a request.
      }
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
      // An 'error' emitted after a successful bind (e.g. an accept-queue
      // error) has no listener left to catch it, and an unhandled 'error' on
      // an EventEmitter takes the whole process down. Log it instead — same
      // shape as server/trigger/http.js's post-bind onError re-attachment.
      server.on('error', (err) => {
        console.warn(`aws-playground: S3 webhook listener error: ${err.message}`);
      });
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
