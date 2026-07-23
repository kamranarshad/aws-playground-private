// Sample TypeScript Node lambda that reads/writes S3 through whatever
// endpoint is configured via the environment. In the playground, enable
// "Local S3" (or ship the playground.json here) and it hits MinIO; with
// real AWS credentials it hits real S3 — the handler is identical.
//
// Register the folder with runtime `node`, handler `dist/index.handler`,
// and (to rebuild) build command `npm install && npm run build`. The
// committed dist/index.js already bundles the SDK, so it runs untouched.
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

interface S3Event {
  action?: 'put' | 'get' | 'list'
  key?: string
  body?: string
}

const BUCKET = 'playground'

const client = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  forcePathStyle: true,
})

async function ensureBucket(): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
  }
}

export const handler = async (event: S3Event) => {
  await ensureBucket()
  const action = event.action ?? 'list'

  if (action === 'put') {
    const key = event.key ?? 'hello.txt'
    const body = event.body ?? 'hello from typescript'
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }))
    return { ok: true, action: 'put', key, bytes: Buffer.byteLength(body) }
  }

  if (action === 'get') {
    const key = event.key ?? 'hello.txt'
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      const body = await res.Body!.transformToString()
      return { ok: true, action: 'get', key, body }
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        return { ok: false, action: 'get', key, error: 'NoSuchKey' }
      }
      throw err
    }
  }

  const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }))
  return {
    ok: true,
    action: 'list',
    keys: (res.Contents ?? []).map((o) => o.Key),
  }
}
