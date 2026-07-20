# Build command + TypeScript lambda support

Functions can run a project build before each invoke, enabling
TypeScript (and any compile-to-JS) lambdas: build, then invoke the
compiled output.

## Per-function build command

- New persisted field `buildCommand` (string, default `''` = none),
  editable in the Settings sheet, allowed in PATCH.
- When set, every invoke runs it first: `spawn(command, { shell: true,
  cwd: fn.path })` with the playground's inherited environment (build
  tools need the real PATH), 60 s cap, stdout+stderr captured.
- Build failure (non-zero exit, timeout, or spawn error) short-circuits
  the invoke: the result envelope is `{ ok: false, phase: 'build',
  error: { type: 'Build.Failed', message, stackTrace: [] }, logs:
  <build output>, report: { requestId: '', durationMs: 0, billedMs: 0,
  memoryMb, timedOut: false, buildMs } }`. It is recorded in history
  like any handler error.
- Build success: build output is prepended to the invoke logs under a
  `=== build ===` / `=== invoke ===` pair of markers, and the report
  gains `buildMs`. Handler duration is unaffected.
- The handler for a built project points at the output, e.g.
  `dist/index.handler` (the harness already resolves subdirectories).
  A missing artifact surfaces as the existing Runtime.ImportModuleError.
- `server/build.js` (new): `runBuild({ dir, command, timeoutMs = 60000 })
  -> Promise<{ ok, output, durationMs, exitCode }>`.

## Detection

`detectProject(dir)` learns TypeScript:

- `.ts`/`.mts`/`.cts` files imply runtime `node`.
- If `package.json` has a `scripts.build`, the response gains
  `buildCommand: 'npm run build'` (else `buildCommand: null`).
- Handler candidates for TS projects come from scanning `.ts` file
  exports; when a tsconfig `outDir` is readable (JSON.parse, falling
  back to a regex scan for `"outDir"`), candidates are prefixed with
  it (e.g. `dist/index.handler`).
- The add-function dialog passes a suggested `buildCommand` through to
  the created function.

## UI

- Settings sheet: "Build command" text input (empty = none).
- Report tab: `Build Duration: <n> ms` line when `report.buildMs` is
  present.
- Types: `FunctionDef.buildCommand: string`,
  `Report.buildMs?: number`, `Detection.buildCommand?: string | null`.

## Fixture: `fixtures/ts-apigw`

- `src/index.ts`: typed API Gateway HTTP API v2 handler with local
  interfaces (no `@types/aws-lambda`): `GET /hello` greets (marks the
  response as TypeScript), `POST /sum` sums a JSON array of numbers
  (400 on invalid body), otherwise 404. Type-stripping-safe syntax.
- `tsconfig.json` (strict, `outDir: dist`, commonjs) and
  `package.json` (`"build": "tsc"`, devDeps typescript + @types/node).
- Compiled `dist/index.js` is committed (Java-jar pattern) so the
  fixture is invokable without installing anything; rebuilding
  requires `npm install` in the fixture, which the user runs — the
  playground only ever runs the configured build command.

## Testing

- `tests/build.test.js`: runBuild success/failure/timeout, output
  capture — hermetic (`node -e` commands, no npm/network).
- `tests/api.test.js`: temp node project whose build command is a tiny
  `node` script that writes `dist/index.js` — asserts built-then-
  invoked flow, `=== build ===` in logs, `buildMs` in report,
  Build.Failed envelope with compiler output in logs and history
  recording; and that functions without buildCommand are untouched.
- `tests/detect.test.js`: TS runtime detection, buildCommand
  suggestion, outDir-prefixed candidates.
- `tests/harness-node.test.js`: invoke `fixtures/ts-apigw` against the
  committed `dist/index.handler` (GET /hello and POST /sum).
- UI verified via headless-browser click-through.

## Out of scope

Skipping the build when sources are unchanged (always builds), watch
mode, dependency installation, per-invoke build-command overrides.
