# aws-playground

A local, Postman-like playground for AWS Lambda handlers. Register your
Lambda project folders, set the handler (same syntax as the AWS console),
pick or write a JSON event, and invoke — response, logs, and a
CloudWatch-style REPORT line, right in your browser.

No Docker. No RIE. No SAM. No LocalStack. No moto. Handlers run directly on
your machine via tiny per-language harnesses (fresh process per invoke =
cold-start semantics, and your latest code edits are always picked up).

## Install & run

    npm install -g .        # or: npx aws-playground (once published)
    aws-playground          # starts the server and opens your browser

Flags: `--port <n>` (default 4590), `--no-open`.

## Supported runtimes

| Runtime | Needs on your machine | Handler syntax |
|---------|----------------------|----------------|
| Python  | `python3` (a project `venv/` is used automatically) | `module.function` |
| Node.js | `node` >= 18 | `file.export` |
| Java    | `java` 11+, project built to a fat jar (`target/` or `build/libs/`) | `com.example.Class::method` |

Projects are assumed ready to run: dependencies installed, Java compiled by
your own tooling. The playground never runs installs or builds.

## Calling AWS services

There is no mocking layer. Set environment variables per function in the UI:
real `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` to hit real
AWS, or `AWS_ENDPOINT_URL` to point the SDK at a self-hosted alternative
(e.g. MinIO for S3). Nothing is inherited from your shell silently.

## Data

Registered functions, per-function env vars, and saved events live in
`~/.aws-playground/functions.json` (override with `AWS_PLAYGROUND_DATA_DIR`).

## Development

    npm install
    npm start          # server without auto-opening the browser
    npm test           # node --test; language tests auto-skip missing runtimes

Architecture and design: `docs/superpowers/specs/2026-07-18-lambda-playground-design.md`.
