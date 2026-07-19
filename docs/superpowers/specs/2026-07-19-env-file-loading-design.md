# Project .env file loading

Lambda projects can supply env vars from a dotenv file in the project
directory, selectable per function.

## Semantics

- Per-function setting `envFile`, persisted in the registry:
  - `auto` (default): load `<project>/.env` when it exists.
  - `none`: load no file.
  - a specific filename (e.g. `.env.local`): load that file from the
    project directory.
- The file is re-read on every invoke (no caching — same freshness
  semantics as code).
- Merge precedence, lowest to highest: harness base env (`PATH`,
  `AWS_*`, …) → .env file → UI env vars (`fn.env`) → per-invoke
  `envVars`.
- A missing or unreadable file contributes nothing and never fails the
  invoke.

## `server/envfile.js` (new, dependency-free)

- `parse(text) -> object` — `KEY=VALUE` per line; optional `export `
  prefix; `#` comments and blank lines skipped; keys must match
  `[A-Za-z_][A-Za-z0-9_]*`; values trimmed, surrounding matching single
  or double quotes stripped; CRLF tolerated; invalid lines skipped.
  No interpolation, no multiline values (documented limitation).
- `resolve(dir, setting) -> object` — applies auto/none/filename;
  filenames must match `^\.env[A-Za-z0-9._-]*$` (no path separators,
  so no traversal); anything else resolves to `{}`.
- `list(dir) -> string[]` — sorted `.env*` filenames present in `dir`
  (files only), for the UI picker; `[]` on unreadable dir.

## Wiring

- `server/store.js`: `envFile` added to `ALLOWED_KEYS`; `create()`
  defaults it to `'auto'`.
- `server/api.js` `invokeFunction`: env becomes
  `{ ...envfile.resolve(fn.path, input.envFile ?? fn.envFile ?? 'auto'),
     ...fn.env, ...(input.envVars || {}) }`.
- `server/detect.js` `detectProject()`: response gains
  `envFiles: envfile.list(dir)`.

## UI

- Env-vars section header gains a compact Select: `Auto (.env)`,
  `None`, and each detected `.env*` file (from `/api/detect` on the
  function's path). Saved via PATCH `envFile`. When `auto` and no
  `.env` exists, the trigger reads "Auto (no .env)".
- `FunctionDef.envFile: string` added to web types.

## Docs

README "Calling AWS services" section documents the picker and the
precedence order.

## Testing

- `tests/envfile.test.js`: parse (quotes, export, comments, CRLF,
  invalid lines), resolve (auto with/without file, none, specific,
  traversal rejected, missing file), list.
- `tests/api.test.js`: end-to-end invoke against a temp project dir
  (copy of the `python-env-echo` handler) with `.env` and `.env.local`,
  asserting file vars load, UI vars win over file vars, per-invoke
  vars win over both, `envFile: 'none'` loads nothing, and a specific
  file selection works.
- `tests/detect.test.js`: `envFiles` listed.
- UI verified via headless-browser click-through.

## Out of scope

Variable interpolation (`${VAR}`), multiline values, file watching,
shared env sets across functions.
