# aws-playground

A local, Postman-like playground for AWS Lambda handlers. Register your
Lambda project folders, set the handler (same syntax as the AWS console),
pick or write a JSON event, and invoke — response, logs, and a
CloudWatch-style REPORT line, right in your browser.

No Docker required. No RIE. No SAM. No LocalStack. No moto. Handlers run directly on
your machine via tiny per-language harnesses (fresh process per invoke =
cold-start semantics, and your latest code edits are always picked up).

## Install & run

    npm install -g .        # or: npx aws-playground (once published)
    aws-playground          # starts the server and opens your browser

Flags: `--port <n>` (default 4590), `--no-open`.

Running the playground itself requires Node >= 22.12.

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
run unchanged — see `fixtures/provided-bash` (bash+curl),
`fixtures/provided-python-exec` (any-executable), and
`fixtures/provided-go` (compiled via build command `go build -o bootstrap .`).

Projects are assumed ready to run: dependencies installed, Java compiled by
your own tooling. The playground never runs installs — but a function can
have a **build command** (e.g. `npm run build`) that runs in the project
folder before every invoke, so compile-to-JS projects stay fresh. A failing
build shows up as `Build.Failed` with the compiler output in the Logs tab;
build time is reported separately from handler duration. TypeScript
projects are auto-detected (build command and `dist/…` handler suggested).
See `fixtures/ts-apigw` for a complete example.

## Calling AWS services

There is no mocking layer. Set environment variables per function in the UI:
real `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` to hit real
AWS, or `AWS_ENDPOINT_URL` to point the SDK at a self-hosted alternative
(e.g. MinIO for S3). Nothing is inherited from your shell silently.

**Local services (docker):** if docker is installed, the Local services
menu in the header can start playground-managed containers. Enable a
service on a function and every invoke gets its endpoint env vars
injected — always overridable by your own env vars. Docker is never
touched unless you click Start.

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

A project's `.env` file is loaded automatically when present, re-read on
every invoke. The env-vars section has a picker to choose a different
`.env.*` file or `None` per function. Precedence, lowest to highest:
.env file → UI env vars → per-invoke overrides. Plain `KEY=VALUE` lines
only (comments and quoted values supported; no interpolation).

## Data

Registered functions, per-function env vars, and saved events live in
`~/.aws-playground/functions.json` (override with `AWS_PLAYGROUND_DATA_DIR`).
Invoke history lives in `<dataDir>/history/<functionId>.jsonl` (50 runs per
function).

## Development

    npm install
    npm run build      # builds the web UI (web/dist) — required once before npm start
    npm start          # server without auto-opening the browser
    npm run dev        # web UI dev server with hot reload (also serves the API)
    npm test           # node --test; language tests auto-skip missing runtimes

Architecture and design: `docs/superpowers/specs/2026-07-18-lambda-playground-design.md` and
`docs/superpowers/specs/2026-07-18-tanstack-start-shadcn-ui-design.md`.
