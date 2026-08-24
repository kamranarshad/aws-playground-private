# aws-playground

A local, Postman-like playground for AWS Lambda handlers. Register your
Lambda project folders, set the handler (same syntax as the AWS console),
pick or write a JSON event, and invoke — response, logs, and a
CloudWatch-style REPORT line, right in your browser.

The sidebar's search box and per-language chips filter the function list
once it grows — a chip solos that language (click it again for every
language back).

No Docker required. No RIE. No SAM. No LocalStack. No moto. Handlers run directly on
your machine via tiny per-language harnesses (fresh process per invoke =
cold-start semantics, and your latest code edits are always picked up).

## Run it

    npx github:kamranarshad/aws-playground     # no clone, no global install

Or from a checkout:

    git clone https://github.com/kamranarshad/aws-playground
    cd aws-playground
    npm install     # installs and builds the web UI
    npm start       # starts the server and opens your browser

Flags: `--port <n>` (default 4590), `--no-open`. From a checkout, pass them
through npm: `npm start -- --port 5000`.

Running the playground itself requires Node >= 22.12. Nothing is installed
globally either way.

## Supported runtimes

| Runtime | Needs on your machine | Handler syntax |
|---------|----------------------|----------------|
| Python  | `python3` (a project `venv/` is used automatically) | `module.function` |
| Node.js | `node` >= 18 | `file.export` |
| TypeScript | `node` >= 18 + your build tooling (e.g. `tsc`) | `dist/index.export` via a build command |
| Java    | `java` 11+, project built to a fat jar (`target/` or `build/libs/`) | `com.example.Class::method` |
| OS-only (`provided`) | any executable (`bash`+`curl`, compiled binaries) | path to the executable, e.g. `bootstrap` |

The OS-only runtime emulates the real Lambda Runtime API
(`AWS_LAMBDA_RUNTIME_API`), so genuine `provided.al2023` bootstrap files
run unchanged — see `fixtures/provided/bash` (bash+curl),
`fixtures/provided/python-exec` (any-executable), and
`fixtures/provided/go` (compiled via build command `go build -o bootstrap .`).

Projects are assumed ready to run: dependencies installed, Java compiled by
your own tooling. The playground never runs installs — but a function can
have a **build command** (e.g. `npm run build`) that runs in the project
folder before every invoke, so compile-to-JS projects stay fresh. A failing
build shows up as `Build.Failed` with the compiler output in the Logs tab;
build time is reported separately from handler duration. TypeScript
projects are auto-detected (build command and `dist/…` handler suggested).
See `fixtures/typescript/apigw` for a complete example.

The bundled TypeScript fixtures declare their own dependencies, and the
playground never installs them for you — a fresh checkout will fail their
build command with `tsc: command not found` or `esbuild: command not found`
until you run `npm run install:fixtures` once.

## Calling AWS services

There is no mocking layer. Set environment variables per function in the UI:
real `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` to hit real
AWS, or `AWS_ENDPOINT_URL` to point the SDK at a self-hosted alternative
(e.g. MinIO for S3). Nothing is inherited from your shell silently — the
one exception is network plumbing (`HTTP(S)_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `AWS_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), which follows the handler in so
outbound calls work on a proxied or TLS-inspecting network. Credential
variables are never inherited.

**Local services (docker):** if docker is installed, the Services page
(the database icon in the left rail) can start playground-managed
containers — start/stop individually or select several and start them
together. Enable a service on a function and every invoke gets its
endpoint env vars injected — always overridable by your own env vars.
Docker is never touched unless you click Start. Each service's
credentials (where it has any) are shown on the Services page,
click-to-copy.

| Service | Image | Endpoint | Persists | Console |
|---------|-------|----------|----------|---------|
| S3 (MinIO) | `minio/minio` | `:9400` (`AWS_ENDPOINT_URL_S3`) | volume | `:9401` (`playground`/`playground123`) |
| SQS (ElasticMQ) | `softwaremill/elasticmq-native` | `:9324` (`AWS_ENDPOINT_URL_SQS`) | no (in-memory) | `:9325` |
| DynamoDB (Local) | `amazon/dynamodb-local` | `:9402` (`AWS_ENDPOINT_URL_DYNAMODB`) | volume | — |
| ElastiCache (Redis) | `redis:alpine` | `:9403` (`REDIS_URL`) | volume | — |
| RDS (PostgreSQL) | `postgres:alpine` | `:9404` (`DATABASE_URL`, `PG*`) | volume | — |

Dummy AWS credentials are injected when any AWS-API service is enabled;
the global `AWS_ENDPOINT_URL` is injected only when exactly one AWS-API
service is enabled (with several, per-service vars avoid misrouting).

See `fixtures/typescript/node-s3` for a worked example: a TypeScript lambda that
reads/writes S3 via the AWS SDK, with a `playground.json` that
auto-starts MinIO when you select it (`{"action":"put","key":"x",
"body":"..."}` / `{"action":"get","key":"x"}` / `{"action":"list"}`).

A project can declare its services in a `playground.json`:
`{"services": ["minio", "elasticmq"]}`. The file is re-read fresh and
overrides the manual toggles. Declared services auto-start when you
select the function and auto-stop ~15 s after no selected function
needs them; services you start manually in the menu are never
auto-stopped. Closing the tab releases the selection, and quitting the
playground stops everything it auto-started — containers you started by
hand are left alone. Service state is polled, so stopping a container
from a terminal is reflected in the UI within a few seconds.

A project's `.env` file is loaded automatically when present, re-read on
every invoke. The env-vars section has a picker to choose a different
`.env.*` file or `None` per function. Precedence, lowest to highest:
.env file → UI env vars → per-invoke overrides. Plain `KEY=VALUE` lines
only (comments and quoted values supported; no interpolation).

Values whose name looks like a secret (`*_SECRET`, `*_PASSWORD`,
`*_TOKEN`, `*_KEY`, …) are masked in the editor with a reveal toggle, so
screen-sharing the playground doesn't broadcast them. They are still
stored in plain text in `functions.json` — the masking is shoulder-surfing
protection, not encryption.

## Logs

Everything the handler writes to stdout and stderr lands in the Logs tab,
one row per entry. A leading timestamp and log level are read off each line
and shown in their own columns — ISO 8601, python `logging`'s
`2026-07-31 10:23:45,123`, or a bracketed `[10:23:45]` for the time; `ERROR`,
`[ERROR]`, or `ERROR:root:` for the level. A line with neither still renders,
just without them.

Stack traces fold into the line that explains them, so a traceback is one
row inheriting that line's level rather than a dozen level-less ones. When a
build command runs, its output appears above the handler's under a `BUILD`
divider.

A search box and per-level chips above the log list filter what's shown — the
search reaches a structured entry's fields as well as its visible message, and
a level chip solos that level (click it again for every level back), the same
interaction the sidebar's language chips use.

Structured logs work too. A line that is a JSON object gets its time, level
and message read out of the object and shown in the same columns, with the
whole entry one click away behind a chevron. Field names vary by logger, so
the common aliases are accepted: `timestamp`/`time`/`@timestamp`/`ts` for the
time, `level`/`status`/`severity`/`levelname` for the level, `message`/`msg`
for the text. pino's numeric levels and epoch timestamps are decoded. JSON
that isn't a log entry — a handler printing `{"statusCode":200}` — is left
alone and shown as the raw text it is.

Nothing in the pipeline stamps log lines for you: the time and level have to
come from whatever the handler itself printed. `fixtures/typescript/winston-datadog`
is the worked example — a winston logger emitting either the text layout or
Datadog's JSON intake shape, switched with `{"format":"json"}`.
`fixtures/java/structured-logging` is the same fixture in Java, hand-rolled
rather than through a logging framework so its `build.sh` stays as dependency-free
as `fixtures/java/hello`'s.

## Data

Registered functions, per-function env vars, and saved events live in
`~/.aws-playground/functions.json` (override with `AWS_PLAYGROUND_DATA_DIR`).
Invoke history lives in `<dataDir>/history/<functionId>.jsonl` (50 runs per
function).

## Development

    npm install         # installs and builds the web UI (web/dist)
    npm start           # server, opens a browser; npm start -- --no-open to skip
    npm run dev         # web UI dev server with hot reload (also serves the API)
    npm run build       # rebuild web/dist after editing the web UI
    npm test            # server (node --test) + web (vitest)
    npm run test:server # server only; language tests auto-skip missing runtimes
    npm run test:web    # web only

`npm install` builds the web UI through npm's `prepare` script, which is also
what makes `npx github:...` work without a clone. Set
`AWS_PLAYGROUND_SKIP_WEB_BUILD=1` to skip that build when you know `web/dist`
is current.

npm is the canonical package manager (CI and `npx github:` depend on it).

The `fixtures/` folder is never part of the build or the published package; it
is sample Lambda projects, each installed on its own. To invoke the TypeScript
fixtures, install their deps once with `npm run install:fixtures`, which finds
every fixture package under `fixtures/`.

CI runs both suites, the web typecheck, and the web build on every push
and pull request (`.github/workflows/ci.yml`).

`server/` is plain CJS with no HTTP server of its own; the web app's
`api.*` routes call straight into it in-process (see
`web/src/lib/backend.ts`) rather than proxying to a separately-running
API process. Server tests live centrally in `tests/*.test.js`; web
tests are colocated next to the source they cover as `*.test.ts(x)`
under `web/src/`.

Architecture and design: `docs/superpowers/specs/2026-07-18-lambda-playground-design.md` and
`docs/superpowers/specs/2026-07-18-tanstack-start-shadcn-ui-design.md`.
