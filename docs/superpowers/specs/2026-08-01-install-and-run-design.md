# Install and run without a global install

Date: 2026-08-01

## Problem

The README tells a new user to run `npm install -g .` and then `aws-playground`.
That is wrong on three counts.

It does not work from a fresh clone. `npm install -g .` runs the `prepare`
lifecycle, and the package has no `prepare` script — only `prepublishOnly`,
which runs on publish and nothing else. So `web/dist` is never built, the
packed tarball is missing the web app, and the binary exits with
`aws-playground: web app not built (web/dist missing).` The user has to already
know to run `npm run build` first.

It pollutes the global bin directory for what is a local tool, and it goes
stale: every source change needs another global install.

And the fallback the README suggests, `npx aws-playground`, is annotated "once
published" — the package is not on the registry, so there is no working
no-clone path at all.

Underneath that sits a smaller install problem. `npm install` at the root
installs nothing, because the root has no dependencies; the real dependencies
live in `web/`, reachable only through `npm run build`. A contributor who runs
`npm install && npm test` gets a web suite that fails on missing vitest.

## Goal

Two commands, one per audience, both working from nothing:

- Someone who wants to use the playground: `npx github:kamranarshad/aws-playground`.
- Someone who wants to work on it: `git clone && npm install && npm start`.

Neither involves `npm install -g`.

## Approach

A `prepare` script is the whole mechanism. npm runs `prepare` both for a plain
`npm install` inside a package directory and for installs from a git URL, so a
single script serves both audiences. It also runs before `npm pack` and
`npm publish`, which makes `prepublishOnly` redundant.

Two approaches were rejected. npm workspaces (`"workspaces": ["web"]`) would
make the root install pull web's dependencies natively and collapse the two
lockfiles into one, but it hoists `web/node_modules` to the root — where
TanStack Start and vite resolution are most likely to surprise us — for a much
larger diff, and it would still need a `prepare` for the build. It is a
reasonable follow-up, not part of this change. Building lazily on first run
inside `bin/cli.js` was rejected because it cannot serve the `npx` path at all:
the git-install tarball respects the `files` allowlist, so `web/src` is not
even shipped and there is nothing to build from.

## Design

### scripts/prepare.js

Wired as `"prepare"` in the root `package.json`. `"build"` becomes an alias for
the same script, so `npm run build` stays the way to rebuild after editing the
web UI. `"prepublishOnly"` is removed.

The script exits 0 without doing anything in two cases:

- `web/package.json` does not exist. This is a packed tarball, where `web/dist`
  is already built and shipped and `web/` source is not present. Building would
  be impossible and is not wanted.
- `AWS_PLAYGROUND_SKIP_WEB_BUILD` is set to a non-empty value. This is the
  escape hatch for callers that already have a current build — notably
  `tests/pack.test.js`, which shells out to `npm pack` and would otherwise
  rebuild the entire UI mid-suite.

Otherwise it checks the Node version before anything else and fails with a
single plain sentence naming the required and actual versions, rather than
letting vite fail with a stack trace about an unsupported syntax. Then it runs,
in the `web/` directory:

- `npm ci` when the `CI` environment variable is set, `npm install` otherwise.
  CI wants the lockfile enforced exactly; a contributor re-running
  `npm install` does not want `node_modules` deleted and refetched each time.
- `npm run build`.

Child processes inherit stdio so the user sees vite's own progress rather than
a silent pause.

The Node-version comparison lives in an exported predicate so it can be unit
tested without spawning anything.

### Scripts in package.json

`"start"` drops `--no-open`, becoming `node bin/cli.js`. The documented command
for running the app should behave like the app; `npm start -- --no-open` and
`npm start -- --port 5000` still forward flags through npm.

`"install:fixtures"` becomes `node scripts/install-fixtures.js`, which walks
`fixtures/` for `package.json` files, skipping `node_modules`, and runs
`npm install` in each directory it finds. The current script hardcodes three
paths, so a fixture added later is silently left uninstalled.

### Guards

A root `.npmrc` with `engine-strict=true` turns the advisory `engines` field
into a hard install-time refusal with a clear message. This covers the clone
path; npm resolves `.npmrc` from the directory the command runs in, so it does
not reach a git install unpacked into a temp directory.

`bin/cli.js` therefore repeats the check at startup, using the same predicate,
and exits 1 with the same sentence. It also changes its existing missing-build
hint from `run: npm run build` to `run: npm install`, which is now the command
that produces a build.

### CI

The three steps `npm ci` / `npm --prefix web ci` / `npm --prefix web run build`
collapse into a single `npm ci`, since `prepare` now does the other two. The
value is not brevity but coverage: CI exercises the exact command a contributor
runs. The `CI` variable is set by GitHub Actions, so `prepare` takes the
`npm ci` branch inside `web/` and the lockfile stays enforced.

`tests/pack.test.js` passes `AWS_PLAYGROUND_SKIP_WEB_BUILD=1` in the
environment of its `npm pack` call. The test already skips when `web/dist` is
absent, so the build it would trigger is always redundant.

### README

`## Install & run` is replaced by `## Run it`:

    npx github:kamranarshad/aws-playground     # no clone needed

    # or from a checkout:
    git clone https://github.com/kamranarshad/aws-playground
    cd aws-playground
    npm install    # installs and builds the web UI
    npm start      # starts the server, opens your browser

Flags and the Node requirement stay. `## Development` loses the line calling
`npm run build` "required once before npm start" — it is now a rebuild command,
not a prerequisite — and keeps the fixtures note, pointing at the discovery
script.

## Testing

Written before the implementation.

`tests/node-version.test.js`: the predicate accepts `v22.12.0`, `v22.20.1` and
`v24.0.0`, rejects `v20.11.0` and `v22.11.0` (the minor is below the floor) and
an unparseable string, and the floor it exports matches `engines.node`.

`tests/prepare.test.js`: `prepare.js` splits its decision from its doing —
`planPrepare({ root, env })` returns either a skip reason or which npm install
mode to use, and is tested directly for all four branches against temporary
package roots. That proves "did not shell out" by construction, which is
stronger than observing a shimmed `npm` was never called. One subprocess test
covers the wiring: running the script with `AWS_PLAYGROUND_SKIP_WEB_BUILD=1`
must exit 0 silently rather than spend a minute in vite.

`tests/fixtures-install.test.js`: the discovery function finds all three current
fixture packages under `fixtures/typescript/`, every path it returns really
contains a `package.json`, it returns nothing from a tree containing only
`node_modules`, and it does not descend into a directory that is already a
package. It deliberately does not assert an exact list — adding a fixture
should not break the test.

The existing suites must still pass unchanged.

## Out of scope

npm workspaces. Publishing to the npm registry. Any build-on-first-run
behaviour in the CLI. Changes to how handlers, fixtures, or services work.
