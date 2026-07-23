# TypeScript S3 lambda fixture (`fixtures/ts-node-s3`)

A TypeScript Node lambda that reads and writes S3 through the injected
local endpoint, demonstrating the Local S3 (MinIO) + `playground.json`
flow end to end.

## Handler (`src/index.ts`)

- AWS SDK v3 (`@aws-sdk/client-s3`). The client is constructed with no
  explicit endpoint/region/credentials — it reads
  `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`, `AWS_REGION` (defaults to
  `us-east-1` if unset), and the dummy creds the playground injects.
  `forcePathStyle: true` (MinIO needs it; the injected endpoint is an
  IP so the SDK already leans this way, but set it explicitly).
- Bucket: `playground` (created on demand; `CreateBucket` swallows
  `BucketAlreadyOwnedByYou`/`BucketAlreadyExists`).
- Event contract `{ action, key?, body? }`:
  - `put` → writes `body` (string, default `"hello from typescript"`)
    to `key`; returns `{ ok: true, action: 'put', key, bytes }`.
  - `get` → reads `key`; returns `{ ok: true, action: 'get', key,
    body }`. Missing key → `{ ok: false, error: 'NoSuchKey', key }`
    (the SDK's real S3 error, caught by name).
  - `list` → returns `{ ok: true, action: 'list', keys: [...] }`.
  - default/unknown action → `list` behavior with a note.
- Typed local interfaces for the event and result; strict TS.

## Packaging

- `tsconfig.json` (strict, target ES2022, module commonjs, no emit
  needed since esbuild bundles).
- `package.json`: dep `@aws-sdk/client-s3`; devDeps `esbuild`,
  `typescript`, `@types/node`; script
  `"build": "esbuild src/index.ts --bundle --platform=node
  --target=node18 --outfile=dist/index.js"`.
- `dist/index.js` (the esbuild bundle, self-contained incl. the SDK)
  is committed — invokes with no install, like the Java jar. Handler
  is `dist/index.handler`. `.gitignore` already ignores nested
  `node_modules`; the fixture's `dist/` is force-added.
- `playground.json`: `{ "services": ["minio"] }` — selecting the
  function auto-starts MinIO.

## Wiring

- No server/runtime changes: it's a plain `node` runtime function
  (handler `dist/index.handler`, build command
  `npm install && npm run build` for rebuilds).
- README runtimes/services text already covers the pieces; add a
  one-line pointer to the fixture as the worked S3 example.

## Testing

- `tests/harness-node.test.js`: invoke `fixtures/ts-node-s3` against
  the committed `dist/index.handler` with a stubbed endpoint — a tiny
  in-test HTTP server on 127.0.0.1 acting as a minimal S3 (PUT/GET/
  list XML, 404 NoSuchKey) with `AWS_ENDPOINT_URL_S3` pointed at it —
  asserting put, get round-trip, and the NoSuchKey path. No docker.
- Real-MinIO E2E in `tests/services-docker.test.js`, gated on the
  minio image being present: start MinIO, invoke put then get through
  the API with the fixture registered, stop MinIO.
- Browser (real docker): register the fixture (playground.json
  auto-starts MinIO on select), invoke put then get, see the round
  trip and the NoSuchKey error on a missing key; console clean.

## Out of scope

Multipart uploads, presigned URLs, other SDK clients, streaming large
objects, a second bundler.
