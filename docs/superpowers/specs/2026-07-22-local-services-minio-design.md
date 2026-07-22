# Local services: playground-managed MinIO (S3)

The playground can start and stop a local MinIO container so lambdas
can hit an S3-compatible endpoint with zero manual setup. Built as a
generic per-service registry (one image per AWS-equivalent service);
MinIO is the first entry. Strictly opt-in: docker is never touched
unless the user clicks Start.

## Decisions (from brainstorming)

- Per-service images, not LocalStack (community LocalStack loses data
  on restart, is ~10x heavier, and has no local seeding console).
- Lifecycle: Start/Stop from the UI; named container + named volume so
  buckets/objects survive restarts and playground upgrades.
- Seeding: MinIO's bundled web console (no in-playground S3 browser).
- Endpoints bind to 127.0.0.1 only and are injected as IP URLs, which
  makes boto3 and JS SDK v3 use path-style addressing automatically.

## `server/services.js`

Registry (data, not code) — first entry:

```
minio: {
  label: 'S3 (MinIO)',
  image: 'minio/minio',
  container: 'aws-playground-minio',
  volume: 'aws-playground-minio-data',
  hostApiPort: 9400, hostConsolePort: 9401,
  runArgs: [-v vol:/data, -p 127.0.0.1:9400:9000,
    -p 127.0.0.1:9401:9001, -e MINIO_ROOT_USER=playground,
    -e MINIO_ROOT_PASSWORD=playground123,
    image, server, /data, --console-address, :9001],
  readyPath: 'http://127.0.0.1:9400/minio/health/live',
  env: { AWS_ENDPOINT_URL: 'http://127.0.0.1:9400',
    AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9400',
    AWS_ACCESS_KEY_ID: 'playground',
    AWS_SECRET_ACCESS_KEY: 'playground123' },
  consoleUrl: 'http://127.0.0.1:9401',
}
```

Functions (all shell out to the `docker` CLI via execFile, 15 s cap):

- `dockerAvailable()` — `docker info` succeeds.
- `status(name)` — absent | stopped | running (docker inspect).
- `start(name)` — `docker start` if the container exists, else
  `docker run -d --name … ` with the registry args; then polls
  `readyPath` until 200 (30 s cap). Returns `{ ok, state, output }`.
- `stop(name)` — `docker stop` (data stays in the volume).
- `list()` — registry + status + docker availability, shaped for the
  API.

Errors (docker missing, port in use, pull failure) surface as
`{ ok: false, output }` — shown in the UI, never thrown.

## API (`server/api.js`)

- `GET /api/services` → `{ docker: { available }, services: [{ name,
  label, state, endpoint, consoleUrl }] }`.
- `POST /api/services/:name/start` / `…/stop` → 200 with the new
  state, 404 unknown service, 409 with output on failure.
- Invoke: new per-function field `localServices` (string array,
  default `[]`, stored via ALLOWED_KEYS). For each entry: if the
  service is running, its `env` map is injected BELOW the .env file
  and UI vars (precedence: base < services < .env file < UI env <
  per-invoke). If enabled but not running, the invoke short-circuits
  like Build.Failed does: `{ ok: false, phase: 'service', error:
  { type: 'Service.NotRunning', message: 'Start S3 (MinIO) from the
  Local services menu or disable it for this function' } }`, recorded
  in history.

## UI

- Header: "Local services" icon button → dropdown listing each
  service with a state dot, Start/Stop button (pending spinner while
  starting), "Open console" link when running, and the endpoint. If
  docker is unavailable: one explanatory line instead of controls.
  Status via TanStack Query, refetched on open and after mutations.
- Env-vars strip: next to the env-file picker, a "Local S3" toggle
  bound to `fn.localServices` containing `'minio'` (PATCH on change).
- Report/logs unchanged; injected vars visible to the handler only.

## README

"Calling AWS services" gains the Local services flow; the top pitch
changes from "No Docker." to "No Docker required" with a note that
the optional local S3 uses docker if present. Data section notes the
docker volume.

## Testing

- `tests/services.test.js` — hermetic via a fake `docker` shim script
  prepended to PATH (records argv, returns scripted output): status
  parsing, start args (volume, loopback ports, creds, image), stop,
  docker-unavailable, ready-poll (against a local http server stub).
- `tests/api.test.js` — services endpoints with the shim; invoke with
  `localServices: ['minio']` while shim reports running (assert
  AWS_ENDPOINT_URL reaches the handler via the env-echo project, and
  that UI env vars still win); enabled-but-stopped →
  `Service.NotRunning` envelope recorded in history.
- Real-docker E2E in `tests/services-docker.test.js`, skipped unless
  the docker daemon responds AND the minio image is already present
  locally (never pulls during tests): start → ready → stop.
- Browser click-through (if docker present on this machine): full
  start → console link → seed a bucket/object → lambda GetObject
  success → stop.

## Out of scope

Additional services (SQS/DynamoDB — registry entries for later),
LocalStack, in-playground bucket browsing, failure-injection rules
(MinIO produces real S3 errors: NoSuchKey, NoSuchBucket, bad creds),
custom ports/creds configuration, podman.
