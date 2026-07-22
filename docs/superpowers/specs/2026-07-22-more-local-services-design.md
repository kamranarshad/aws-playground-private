# More local services: SQS, DynamoDB, Redis, PostgreSQL

Four registry additions alongside MinIO, plus corrected multi-service
env composition. All containers/volumes named `aws-playground-*`,
all ports bound to 127.0.0.1, docker touched only on explicit action.

## Registry entries (`server/services.js`)

- `elasticmq` — label "SQS (ElasticMQ)", image
  `softwaremill/elasticmq-native`, ports 9324 (API) + 9325 (web UI),
  NO volume (queues are in-memory; registry `note: 'queues are
  ephemeral — recreated on restart'` shown in the menu), env
  `AWS_ENDPOINT_URL_SQS=http://127.0.0.1:9324`, HTTP ready check
  (any response), consoleUrl :9325.
- `dynamodb` — label "DynamoDB (Local)", image
  `amazon/dynamodb-local`, port 9402→8000, volume
  `aws-playground-dynamodb-data:/home/dynamodblocal/data`, command
  `-jar DynamoDBLocal.jar -sharedDb -dbPath /home/dynamodblocal/data`,
  env `AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:9402`, HTTP ready
  check accepting any status (GET / returns 400), no console.
- `redis` — label "ElastiCache (Redis)", image `redis:alpine`, port
  9403→6379, volume `aws-playground-redis-data:/data`, command
  `redis-server --appendonly yes`, env
  `REDIS_URL=redis://127.0.0.1:9403`, TCP ready check, no console.
- `postgres` — label "RDS (PostgreSQL)", image `postgres:alpine`,
  port 9404→5432, volume
  `aws-playground-postgres-data:/var/lib/postgresql/data`, container
  env `POSTGRES_USER=playground POSTGRES_PASSWORD=playground123
  POSTGRES_DB=playground`, injected env
  `DATABASE_URL=postgresql://playground:playground123@127.0.0.1:9404/playground`
  plus `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, TCP ready
  check, no console.

Registry entries gain `kind: 'aws' | 'plain'` (minio/elasticmq/
dynamodb are aws; redis/postgres plain), optional `note`, nullable
`consoleUrl`, and `ready: { type: 'http' | 'tcp', target }`.
`waitReady` handles both types; HTTP accepts any response status.

## Env composition (`server/api.js`)

Replaces the flat merge of `envFor` maps:

- Each enabled+running service contributes its own vars (above).
- If ANY enabled service has `kind: 'aws'`: inject dummy
  `AWS_ACCESS_KEY_ID=playground` / `AWS_SECRET_ACCESS_KEY=playground123`
  (moved out of minio's per-service map).
- If EXACTLY ONE enabled service has `kind: 'aws'`: also inject
  global `AWS_ENDPOINT_URL=<that service's endpoint>` for older SDKs.
  Two or more aws services → no global var (it would misroute).
- Precedence unchanged: services < .env file < UI env < per-invoke.
- `services.envFor(name)` returns only the per-service map;
  composition lives in a new `services.composeEnv(names)` used by
  api.js (unit-testable without docker).

## UI

- `env-editor`: the hardcoded "Local S3" checkbox becomes one
  checkbox per registry service, labelled from a new `shortLabel`
  (S3, SQS, DynamoDB, Redis, Postgres), toggling membership in
  `fn.localServices` (preserving other entries).
- `services-menu`: console link hidden when `consoleUrl` null;
  `note` rendered as muted small text; MinIO console-login hint only
  for minio.

## Testing

- `tests/services.test.js`: run args per new service (image, ports,
  volumes, command, container env), composeEnv rules (single aws →
  global; two aws → no global; aws+plain → global still present;
  plain only → no AWS vars at all).
- `tests/api.test.js`: invoke-level composition via env-echo project
  with shim reporting running (minio+elasticmq: per-service vars
  present, no global; minio+redis: global present).
- `tests/services-docker.test.js`: gated start→ready→stop per
  service, each skipped unless its image is present locally.
- Browser: menu lists all five, start/stop + toggle exercise for at
  least SQS and DynamoDB, console clean.

## README

Services table (image, port, persistence, console) replacing the
MinIO-only paragraph; note the env composition rule.

## Out of scope

Fixtures for the new services, custom ports/creds, SNS/Kinesis (no
solid standalone images), health-chip entries for services (the menu
is the status surface).
