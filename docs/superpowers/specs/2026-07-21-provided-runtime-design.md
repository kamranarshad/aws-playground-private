# OS-only (`provided`) runtime

A fourth runtime emulating AWS's custom-runtime contract
(`provided.al2023`): the playground runs any executable as a lambda by
speaking the real Lambda Runtime API, so genuine AWS bootstrap files
work unchanged.

## Runtime semantics

- Runtime id `provided`; handler field = executable path relative to
  the project directory (AWS convention: `bootstrap`).
- Health check: `sh` on PATH (`sh -c 'echo ok'`); label `os` in the UI.
- Fresh process per invoke, like every other runtime.

## Harness: `harnesses/provided/harness.mjs`

Node script, same CLI contract as the other harnesses (`--handler`,
`--result-file`, `--timeout-ms`, `--memory-mb`, `--request-id`; event
JSON on stdin; envelope JSON to the result file).

1. Validate the handler: file must exist and be executable
   (`fs.accessSync X_OK`); otherwise write phase `init`,
   `Runtime.InvalidEntrypoint`.
2. Start `http.createServer` on `127.0.0.1:0` implementing:
   - `GET /2018-06-01/runtime/invocation/next` — responds with the
     event; headers `Lambda-Runtime-Aws-Request-Id`,
     `Lambda-Runtime-Deadline-Ms`,
     `Lambda-Runtime-Invoked-Function-Arn`,
     `Lambda-Runtime-Trace-Id`. First serve starts the duration clock.
     Served repeatedly (bootstraps loop); the harness exits after the
     first completed invocation.
   - `POST /2018-06-01/runtime/invocation/<id>/response` — body is the
     response payload (JSON parsed; falls back to the raw string).
     Writes `{ ok: true, phase: 'invoke', response, durationMs }`.
   - `POST /2018-06-01/runtime/invocation/<id>/error` — body
     `{ errorMessage, errorType, stackTrace? }` (tolerant of
     non-JSON). Writes `{ ok: false, phase: 'invoke', error }`.
   - `POST /2018-06-01/runtime/init/error` — same shape, phase `init`.
3. Spawn the executable: cwd = project dir, own process group
   (`detached` on POSIX), env = harness env plus
   `AWS_LAMBDA_RUNTIME_API=127.0.0.1:<port>`, `_HANDLER=<handler>`.
   Bootstrap stdout/stderr pass through to the harness's (captured as
   logs by the invoker).
4. Exit paths:
   - Response or error posted → write envelope, SIGKILL the
     bootstrap's process group, exit 0.
   - Bootstrap exits first → `Runtime.ExitError` with the exit code,
     phase `invoke` (phase `init` if `/next` was never polled).
   - Overall timeout stays the invoker's job (it kills the whole
     process group).

## Wiring

- `server/invoker.js` `command()`: `provided` → `process.execPath` +
  the provided harness (same shape as the node branch).
- `server/api.js`: `RUNTIMES` gains `'provided'`; health gains
  `sh: checkRuntime('sh', ['-c', 'echo ok'])` reported under key
  `provided`.
- `server/detect.js`: if the directory contains a file named
  `bootstrap`, runtime is `provided` (checked before other
  heuristics); handler candidates = `bootstrap` (if present) plus any
  executable `*.sh` files.
- UI: runtime option `provided` in the add dialog; health chip
  labelled `os`. Everything else is runtime-agnostic.
- README runtimes table row.

## Fixtures

- `fixtures/provided-bash/bootstrap` (committed executable): AWS
  tutorial style — `while` loop, `curl -s` to
  `$AWS_LAMBDA_RUNTIME_API/2018-06-01/runtime/invocation/next`,
  responds with `{"echo": <event>, "runtime": "bash"}` via jq-free
  string assembly.
- `fixtures/provided-python-exec/bootstrap` (committed executable):
  `#!/usr/bin/env python3`, stdlib `urllib.request` — demonstrates
  any-executable; responds with the event keys uppercased.
- `fixtures/provided-go`: `main.go` + `go.mod` (no committed binary —
  platform-specific); build command `go build -o bootstrap .`,
  handler `bootstrap`. Uses stdlib `net/http` against the Runtime API.

## Testing

- `tests/harness-provided.test.js` (skips when `bash` missing):
  bash-fixture happy path; a script that POSTs to `/error`; a script
  that exits without posting (`Runtime.ExitError`); missing
  executable (`Runtime.InvalidEntrypoint`); non-executable file.
- `tests/detect.test.js`: bootstrap → provided + candidates.
- `tests/api.test.js`: runtime validation accepts `provided`; invoke
  of `provided-bash` end-to-end (skip when bash missing).
- Go fixture: api-level build+invoke test skipped unless `go` is on
  PATH.
- UI verified via headless-browser click-through.

## Out of scope

Multiple sequential invocations per process (warm starts), the
`getRemainingTimeInMillis`-style context extras beyond the standard
headers, Windows support for this runtime.
