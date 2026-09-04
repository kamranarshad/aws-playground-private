const { requireOptional } = require('../../optional-deps');
const { awsClientOptions } = require('../../services/registry');
const { NOTIFICATION_ID, NOTIFICATION_ARN } = require('./events');

// Everything that talks to MinIO's S3 API: creating the bucket and keeping
// its notification configuration pointed at our webhook. The lazily-loaded
// SDK lives here because this is its only consumer -- the listener and the
// driver never touch it.
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

function buildClient() {
  const { S3Client } = s3Sdk();
  return new S3Client({ ...awsClientOptions('minio'), region: 'us-east-1', forcePathStyle: true });
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

module.exports = {
  s3Sdk, buildClient, ensureBucket, syncBucketNotification, ensureBucketConfig,
  S3_MISSING_MESSAGE,
};
