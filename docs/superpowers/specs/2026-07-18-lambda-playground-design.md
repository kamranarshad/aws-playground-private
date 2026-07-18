# Lambda Playground — Design

**Date:** 2026-07-18
**Status:** Approved (brainstorming session)

## What this is

A local, Postman-like web app for testing AWS Lambda handlers. You register
existing Lambda project folders on disk, set the handler string (same syntax
as the AWS console), write or pick a JSON event, and invoke — getting back
the response, logs, and a CloudWatch-style REPORT line, like the AWS console
test screen.

Runs handlers **directly on the host** using locally installed language
runtimes. Explicitly excluded by requirement: Docker, AWS RIE, SAM CLI,
LocalStack, and moto. No mocking layer of any kind — the app manages
environment variables per function; if AWS credentials are set, SDK calls hit
real AWS; if `AWS_ENDPOINT_URL` points at a self-hosted alternative (e.g.
MinIO for S3), calls go there.

## Supported languages (v1)

| Runtime | How it runs | Notes |
|---------|-------------|-------|
| Python | `harness.py` via project venv Python if present, else system `python3` | importlib-loads `module.function` |
| Node.js | `harness.mjs` via system `node` | imports `file.export`; async and callback handler styles |
| Java | prebuilt `harness.jar` via system `java` | reflection over the user's built jar; supports `RequestHandler` and `RequestStreamHandler`; JSON library shaded into the harness jar |

Projects are assumed **ready to run**: dependencies already installed
(venv / `node_modules`) and Java already built to a jar by the user's own
tooling. The app detects artifacts (venv, `target/*.jar`, `build/libs/*.jar`)
but never runs installs or builds.

## Architecture

Node.js + Express server (port 4590) serving a static vanilla-JS frontend,
plus one small harness per language. No build step for the app itself.

```
server/
  index.js          Express: /api/functions, /api/invoke, /api/health
  invoker.js        Spawns harness processes, enforces timeout, collects results
  detect.js         Runtime / handler / venv / jar detection for a folder
harnesses/
  python/harness.py
  node/harness.mjs
  java/               harness source + prebuilt harness.jar
public/               UI (sidebar, event editor, result tabs)
data/functions.json   persisted registry of functions
fixtures/             tiny real Lambda projects used by tests
```

### Execution model: fresh subprocess per invoke

One invoke = one fresh harness process (Lambda cold-start semantics).
Perfect isolation between invokes; IDE edits always picked up because code is
re-loaded every time. Trade-off accepted: Java pays JVM startup (~1s) per
invoke. A warm-worker mode could be added later as an opt-in without changing
this architecture; it is out of scope for v1.

### Invocation flow

1. UI sends `POST /api/invoke` with `{functionId, handler, event, envVars, timeoutMs}`.
2. Server resolves the interpreter (venv Python → system python3; node; java
   with classpath = user jar + harness jar).
3. Server spawns the harness with `cwd` = project folder and a **clean
   environment**: host basics (`PATH`, `HOME`, `TMPDIR`, `LANG`, and
   `JAVA_HOME` if set) + Lambda-standard vars (`AWS_LAMBDA_FUNCTION_NAME`,
   `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_VERSION`,
   `AWS_REGION` defaulting to `us-east-1`) + the user's per-function env
   vars, which take precedence over the defaults. Nothing AWS-related is
   inherited from the server's own environment. The event JSON is passed on
   stdin.
4. Harness loads the handler, builds a faithful `context` object (request id,
   function name, memory size, `get_remaining_time_in_millis` wired to the
   configured timeout), invokes it, and writes a result envelope to a **temp
   result file** whose path the server passed as an argument:
   `{ok, phase: "init"|"invoke", response | error{type, message, stackTrace}, durationMs}`.
   All of the user code's stdout/stderr is captured separately as logs and is
   never confused with the result.
5. Server enforces the timeout by killing the process tree, then returns
   `{response, logs, report}` — report styled like a CloudWatch `REPORT` line
   (request id, duration, billed duration, configured memory).

### Handler string syntax (AWS console-identical)

- Python: `app.handler` / `pkg.module.function`
- Node: `index.handler` (file path without extension + export name)
- Java: `com.example.App::handleRequest` (method optional when the class
  implements `RequestHandler`)

## UI & data model

The registered unit is a **function** (path + runtime + handler), not a
folder — one repo with several handlers can be registered as several
functions.

Single-page UI, dark console theme (IBM Plex Sans/Mono, amber accent — the
design system from the original README):

- **Sidebar** — registered functions; "Add function" form takes an absolute
  folder path, the server scans it and suggests runtime + handler candidates,
  the user confirms. A header health strip shows detected host runtimes
  (python3 / node / java versions) and flags functions whose runtime is
  missing.
- **Main pane** for the selected function:
  - Config row: runtime badge, handler field, timeout (default 30 s), memory
    size (cosmetic — feeds context + REPORT), Java jar-path override.
  - Env vars editor: key/value rows, persisted per function (credentials,
    `AWS_REGION`, `AWS_ENDPOINT_URL`, app config…).
  - Event editor: CodeMirror JSON with template dropdown (Empty, API Gateway
    proxy, S3 put, SQS, EventBridge, DynamoDB stream) and named **saved
    events** per function, like the console's saved test events.
  - Invoke button → **Response / Logs / Report** tabs.
  - Session-only invocation history (click a past invoke to re-view its
    result; not persisted).

Persistence is server-side in `data/functions.json`:

```json
{ "functions": [ {
    "id": "…", "name": "resize-image", "path": "/abs/path",
    "runtime": "python", "handler": "app.handler",
    "timeoutMs": 30000, "memoryMb": 128, "jarPath": null,
    "env": { "AWS_REGION": "eu-west-1" },
    "savedEvents": [ { "name": "s3-put", "json": "…" } ]
} ] }
```

## Error handling

Every failure maps to how real Lambda reports it:

| Failure | Behavior |
|---------|----------|
| Handler exception | `{errorType, errorMessage, stackTrace}` in Response tab (red state); stack trace also in Logs |
| Init failure (bad handler string, import error) | Envelope tagged `phase: "init"`; UI states the function failed before the handler ran |
| Timeout | Process tree killed; `Task timed out after N seconds` |
| Process crash without envelope (`process.exit`, segfault, OOM) | "Runtime exited" error + captured stderr as logs |
| Missing host runtime | Pre-flight check with install hint; also flagged in sidebar health strip |
| Invalid event JSON | Caught client-side before sending |

Concurrency: one in-flight invoke per function (button disabled while
running); different functions may invoke in parallel.

## Testing

`node:test` (no extra dependencies), driven by committed fixtures:

- `fixtures/`: `python-hello`, `python-error`, `python-timeout`,
  `python-env-echo`, `node-hello` (async + callback styles), `java-hello`
  (minimal prebuilt jar checked in, plus its source).
- Integration tests boot the Express server and exercise `/api/invoke`
  against each fixture: response shape, log capture, REPORT fields, timeout
  kill, and each error class above.
- Tests auto-skip a language whose runtime isn't installed on the current
  machine, so the suite passes on any contributor setup and in CI.

## Out of scope for v1

- Docker / container execution of any kind
- Warm-container or warm-process pool
- Running installs or builds for user projects
- AWS service mocking or emulation
- Concurrent invokes of the same function / load testing
- Go and Ruby runtimes (candidates for v2; Go would need a build step and
  `_LAMBDA_SERVER_PORT` local RPC mode)
- Persisted invocation history
