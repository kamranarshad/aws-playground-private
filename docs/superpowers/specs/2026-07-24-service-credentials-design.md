# Service credentials on the Services page

Each service row on `/services` shows its credentials (where it has
any), each value click-to-copy. Purely additive; no lifecycle or
env-injection changes.

## Registry (`server/services.js`)

Each entry gains `credentials: { label, value }[]`. AWS-API services
(`kind: 'aws'`) show the dummy access key/secret a client uses (the
same pair `composeEnv` injects); `postgres` shows its own login;
`redis` has none.

- `minio`: Access key `playground`, Secret key `playground123`
  (also the console login).
- `elasticmq`: Access key `playground`, Secret key `playground123`.
- `dynamodb`: Access key `playground`, Secret key `playground123`.
- `postgres`: User `playground`, Password `playground123`,
  Database `playground`.
- `redis`: `credentials: []` (no authentication).

The AWS pairs are the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
the playground injects; showing them lets you plug the same values
into a console (MinIO) or an external client without guessing.

## API / types

- `list()` already flows through `GET /api/services`; `credentials`
  rides along, no endpoint change.
- `LocalService` type gains `credentials: { label: string; value:
  string }[]`.

## UI (`service-row.tsx`)

- Replace the minio-only "Console login: …" hint with a general
  credentials block, shown whenever `credentials.length > 0`:
  a small stacked list, each line `LABEL  value  [copy]` — label in
  the mono uppercase muted style, value in mono, and a copy button
  (lucide `Copy`, briefly swapping to `Check` on click via
  `navigator.clipboard.writeText`). Clipboard failure → a toast, no
  throw.
- Services with empty `credentials` (redis) show a single muted
  "no authentication" line so the absence reads as intentional, not
  missing.
- `Copy`/`Check` swap is per-value local state in a small
  `CopyableValue` component so multiple copies don't share state.

## Testing

- `tests/services.test.js`: `list()` includes the expected
  credentials for minio/elasticmq/dynamodb (access+secret) and
  postgres (user/password/database), and `[]` for redis.
- Browser: the Services page shows MinIO's access/secret keys and
  Postgres's user/password/database; a copy button copies the value
  (assert via `navigator.clipboard.readText` in the page or by
  reading the button's post-click state); redis row shows no creds
  block; console clean.

## README

One line under Local services: credentials for each service are
shown on the Services page.

## Out of scope

Editing/rotating credentials, revealing/masking secrets (values are
dummy local creds, shown in full), connection-string display,
credentials for future non-registry services.
