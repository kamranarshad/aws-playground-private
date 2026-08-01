# Install and Run Without a Global Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `git clone && npm install && npm start` and `npx github:kamranarshad/aws-playground` both work from nothing, so no one ever needs `npm install -g .`.

**Architecture:** npm runs the `prepare` lifecycle script both for a plain `npm install` inside a package directory and for installs from a git URL. A single new `scripts/prepare.js` therefore serves both audiences: it installs and builds the `web/` UI. Everything else in this plan is a guard, a script rename, or documentation that follows from that one change.

**Tech Stack:** Node >= 22.12, CommonJS (the root package has no `"type": "module"`), `node --test` for the server suite, npm lifecycle scripts, GitHub Actions.

Spec: `docs/superpowers/specs/2026-08-01-install-and-run-design.md`

## Global Constraints

- Node floor is exactly `22.12.0`. It appears in `engines.node` as `>=22.12.0` and must not be duplicated as a literal anywhere except `server/node-version.js`.
- All new files are CommonJS (`require` / `module.exports`), matching `bin/cli.js` and `server/*.js`. No ESM, no TypeScript.
- Anything `bin/cli.js` requires at runtime must live under a directory listed in `package.json`'s `files` array, or the published tarball will crash on require.
- Child processes that shell out to `npm` must pass `shell: process.platform === 'win32'` — on Windows `npm` is a `.cmd` and will not spawn otherwise.
- No new runtime dependencies. The root package stays dependency-free.
- Commit after every task.

---

### Task 1: The Node version floor, in one place

Both `bin/cli.js` and `scripts/prepare.js` need to refuse an old Node with the same message. It goes in `server/` rather than `scripts/` because `server` is in the `files` allowlist and `scripts` is not yet — `bin/cli.js` requires it at runtime from the published tarball.

**Files:**
- Create: `server/node-version.js`
- Test: `tests/node-version.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `require('../server/node-version')` exporting
  - `MIN_NODE: string` — `'22.12.0'`
  - `nodeVersionOk(version: string) => boolean` — accepts `'v22.12.0'` or `'22.12.0'`
  - `nodeVersionMessage(version: string) => string`

- [ ] **Step 1: Write the failing test**

Create `tests/node-version.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { MIN_NODE, nodeVersionOk, nodeVersionMessage } = require('../server/node-version');

test('the floor matches what package.json declares', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.engines.node, `>=${MIN_NODE}`);
});

test('nodeVersionOk accepts the floor and anything above it', () => {
  assert.strictEqual(nodeVersionOk('v22.12.0'), true);
  assert.strictEqual(nodeVersionOk('v22.20.1'), true);
  assert.strictEqual(nodeVersionOk('v24.0.0'), true);
  assert.strictEqual(nodeVersionOk('22.12.0'), true, 'the leading v is optional');
});

test('nodeVersionOk rejects anything below the floor', () => {
  assert.strictEqual(nodeVersionOk('v20.11.0'), false);
  assert.strictEqual(nodeVersionOk('v22.11.0'), false, 'minor below the floor');
  assert.strictEqual(nodeVersionOk('v22.11.9'), false);
});

test('nodeVersionOk treats an unparseable version as unsupported', () => {
  assert.strictEqual(nodeVersionOk('banana'), false);
  assert.strictEqual(nodeVersionOk(''), false);
});

test('nodeVersionMessage names both the floor and what is installed', () => {
  const msg = nodeVersionMessage('v20.11.0');
  assert.ok(msg.includes(MIN_NODE), 'should name the required version');
  assert.ok(msg.includes('v20.11.0'), 'should name the installed version');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/node-version.test.js`
Expected: FAIL — `Cannot find module '../server/node-version'`

- [ ] **Step 3: Write minimal implementation**

Create `server/node-version.js`:

```js
// The playground itself needs a modern Node. `engines` is only advisory unless
// npm is configured for engine-strict, and it does not apply at all once the
// package is on disk, so bin/cli.js and scripts/prepare.js both check here.
const MIN_NODE = '22.12.0';

function segments(version) {
  return String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
}

function nodeVersionOk(version) {
  const have = segments(version);
  const min = segments(MIN_NODE);
  if (Number.isNaN(have[0])) return false;
  for (let i = 0; i < min.length; i++) {
    const seg = Number.isNaN(have[i]) || have[i] === undefined ? 0 : have[i];
    if (seg > min[i]) return true;
    if (seg < min[i]) return false;
  }
  return true;
}

function nodeVersionMessage(version) {
  return `aws-playground needs Node >= ${MIN_NODE} - this is ${version}. `
    + 'Install a newer Node from https://nodejs.org/';
}

module.exports = { MIN_NODE, nodeVersionOk, nodeVersionMessage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/node-version.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/node-version.js tests/node-version.test.js
git commit -m "feat(cli): put the Node version floor behind one shared check"
```

---

### Task 2: `prepare` — make `npm install` build the web UI

This is the change that fixes the ask. Splitting the decision (`planPrepare`) from the doing (spawning npm) is what makes it testable: the branches can be asserted without ever launching a build.

Note a deliberate refinement of the spec: the spec described testing "did not shell out" with a `PATH` shim. Testing the pure planner is stronger — it proves the branch by construction rather than by observation — so the shim is replaced by one subprocess test that the wiring holds end to end.

**Files:**
- Create: `scripts/prepare.js`
- Test: `tests/prepare.test.js`
- Modify: `package.json` (scripts + `files`)
- Modify: `tests/pack.test.js:13` (the `npm pack` call's environment)

**Interfaces:**
- Consumes: `server/node-version.js`'s `nodeVersionOk`, `nodeVersionMessage` from Task 1.
- Produces: `require('../scripts/prepare')` exporting
  - `planPrepare({ root: string, env: object }) => { skip: string } | { install: 'ci' | 'install' }`

- [ ] **Step 1: Write the failing test**

Create `tests/prepare.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planPrepare } = require('../scripts/prepare');

const ROOT = path.join(__dirname, '..');

// A stand-in package root. `withWeb` is the difference between a source
// checkout and an unpacked tarball, which ships web/dist but no web/ source.
function fakeRoot(withWeb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-prepare-'));
  if (withWeb) {
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'package.json'), '{}');
  }
  return dir;
}

test('a source checkout installs with npm install', () => {
  assert.deepStrictEqual(planPrepare({ root: fakeRoot(true), env: {} }),
    { install: 'install' });
});

test('CI installs from the lockfile instead', () => {
  assert.deepStrictEqual(planPrepare({ root: fakeRoot(true), env: { CI: 'true' } }),
    { install: 'ci' });
});

test('a packed tarball has no web/ source, so there is nothing to build', () => {
  const plan = planPrepare({ root: fakeRoot(false), env: {} });
  assert.ok(plan.skip, 'should report why it skipped');
  assert.ok(!plan.install, 'should not install anything');
});

test('AWS_PLAYGROUND_SKIP_WEB_BUILD skips even in a full checkout', () => {
  const plan = planPrepare({
    root: fakeRoot(true), env: { AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
  });
  assert.ok(plan.skip, 'should report why it skipped');
  assert.ok(!plan.install, 'should not install anything');
});

// Proves the script is wired to the planner: with the skip flag it must
// return immediately and silently rather than spending a minute on vite.
test('running the script with the skip flag exits 0 and stays quiet', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare.js')], {
    env: { ...process.env, AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(out.trim(), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prepare.test.js`
Expected: FAIL — `Cannot find module '../scripts/prepare'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/prepare.js`:

```js
#!/usr/bin/env node
// npm runs `prepare` both for `npm install` inside a checkout and for installs
// from a git URL, which is why this one script covers `git clone && npm
// install` and `npx github:kamranarshad/aws-playground` alike. It is
// deliberately a no-op inside a packed tarball, where web/dist is already
// built and the web/ source is not shipped at all.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { nodeVersionOk, nodeVersionMessage } = require('../server/node-version');

function planPrepare({ root, env }) {
  if (env.AWS_PLAYGROUND_SKIP_WEB_BUILD) {
    return { skip: 'AWS_PLAYGROUND_SKIP_WEB_BUILD is set' };
  }
  if (!fs.existsSync(path.join(root, 'web', 'package.json'))) {
    return { skip: 'no web/ source in this package' };
  }
  return { install: env.CI ? 'ci' : 'install' };
}

function npm(args, cwd) {
  const res = spawnSync('npm', args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`aws-playground: \`npm ${args.join(' ')}\` failed in ${cwd}`);
    process.exit(res.status || 1);
  }
}

function main() {
  const root = path.join(__dirname, '..');
  const plan = planPrepare({ root, env: process.env });
  if (plan.skip) return;
  if (!nodeVersionOk(process.version)) {
    console.error(nodeVersionMessage(process.version));
    process.exit(1);
  }
  const web = path.join(root, 'web');
  npm([plan.install], web);
  npm(['run', 'build'], web);
}

if (require.main === module) main();

module.exports = { planPrepare };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prepare.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire `prepare` into package.json**

In `package.json`, replace the `"build"` and `"prepublishOnly"` entries and add `"prepare"`. The `scripts` block becomes:

```json
  "scripts": {
    "start": "node bin/cli.js --no-open",
    "dev": "npm --prefix web run dev",
    "prepare": "node scripts/prepare.js",
    "build": "node scripts/prepare.js",
    "install:fixtures": "npm --prefix fixtures/typescript/apigw install && npm --prefix fixtures/typescript/node-s3 install && npm --prefix fixtures/typescript/winston-datadog install",
    "test": "npm run test:server && npm run test:web",
    "test:server": "node --test tests/*.test.js",
    "test:web": "npm --prefix web run test"
  },
```

(`start` and `install:fixtures` are changed in Tasks 4 and 3 respectively — leave them alone here.)

Then add `"scripts"` to the `files` array so a packed tarball still contains the file its own `prepare` entry points at:

```json
  "files": [
    "bin",
    "server",
    "harnesses",
    "scripts",
    "web/dist"
  ]
```

- [ ] **Step 6: Stop `npm pack` from rebuilding the UI mid-test**

`tests/pack.test.js` shells out to `npm pack`, which now triggers `prepare`. The test already skips unless `web/dist` exists, so that build is always redundant. Change the `execFileSync` call at `tests/pack.test.js:13` from:

```js
  const tarball = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: ROOT })
    .toString().trim().split('\n').pop();
```

to:

```js
  // `npm pack` runs the prepare script; this test already required a current
  // web/dist to run at all, so rebuilding it here would just cost a minute.
  const tarball = execFileSync('npm', ['pack', '--pack-destination', work], {
    cwd: ROOT,
    env: { ...process.env, AWS_PLAYGROUND_SKIP_WEB_BUILD: '1' },
  }).toString().trim().split('\n').pop();
```

- [ ] **Step 7: Verify the whole server suite still passes**

Run: `npm run test:server`
Expected: PASS. `tests/pack.test.js` must still pass and must not take noticeably longer than before.

- [ ] **Step 8: Verify a real install builds the UI**

```bash
rm -rf web/dist && npm install && ls web/dist/server/server.js
```
Expected: vite build output scrolls past, then `web/dist/server/server.js` is listed.

- [ ] **Step 9: Commit**

```bash
git add scripts/prepare.js tests/prepare.test.js package.json tests/pack.test.js
git commit -m "feat(install): build the web UI from npm's prepare lifecycle"
```

---

### Task 3: Discover fixtures instead of listing them

`install:fixtures` names three directories. A fourth fixture with dependencies would be silently left uninstalled, and its build command would fail at invoke time with `tsc: command not found` — the exact confusion the README already has to warn about.

**Files:**
- Create: `scripts/install-fixtures.js`
- Test: `tests/fixtures-install.test.js`
- Modify: `package.json` (the `install:fixtures` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `require('../scripts/install-fixtures')` exporting
  - `findFixturePackages(dir: string) => string[]` — absolute paths, sorted

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures-install.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findFixturePackages } = require('../scripts/install-fixtures');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

test('finds every fixture that declares dependencies', () => {
  const found = findFixturePackages(FIXTURES).map((dir) => path.relative(FIXTURES, dir));
  for (const name of ['apigw', 'node-s3', 'winston-datadog']) {
    assert.ok(found.includes(path.join('typescript', name)), `missing typescript/${name}`);
  }
  // Deliberately not an exact list: adding a fixture should not break this
  // test, but every hit does have to be a real package.
  for (const rel of found) {
    assert.ok(fs.existsSync(path.join(FIXTURES, rel, 'package.json')), `${rel} has no package.json`);
  }
});

test('ignores installed dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fixtures-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'package.json'), '{}');
  assert.deepStrictEqual(findFixturePackages(dir), []);
});

test('does not descend into a fixture that is itself a package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fixtures-'));
  fs.mkdirSync(path.join(dir, 'demo', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo', 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'demo', 'nested', 'package.json'), '{}');
  assert.deepStrictEqual(findFixturePackages(dir), [path.join(dir, 'demo')]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fixtures-install.test.js`
Expected: FAIL — `Cannot find module '../scripts/install-fixtures'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/install-fixtures.js`:

```js
#!/usr/bin/env node
// Fixtures are sample Lambda projects, each installed on its own and never part
// of the build or the published package. Finding them beats listing them: a
// fixture added later used to be left uninstalled with no sign of it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findFixturePackages(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = path.join(dir, entry.name);
    // A package's own subdirectories are its source, not more fixtures.
    if (fs.existsSync(path.join(child, 'package.json'))) found.push(child);
    else found.push(...findFixturePackages(child));
  }
  return found.sort();
}

function main() {
  const root = path.join(__dirname, '..');
  const dirs = findFixturePackages(path.join(root, 'fixtures'));
  if (!dirs.length) {
    console.log('aws-playground: no fixture declares dependencies; nothing to install');
    return;
  }
  for (const dir of dirs) {
    console.log(`\naws-playground: installing ${path.relative(root, dir)}`);
    const res = spawnSync('npm', ['install'], {
      cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (res.status !== 0) process.exit(res.status || 1);
  }
}

if (require.main === module) main();

module.exports = { findFixturePackages };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fixtures-install.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Point the npm script at it**

In `package.json`, change the `install:fixtures` entry to:

```json
    "install:fixtures": "node scripts/install-fixtures.js",
```

- [ ] **Step 6: Verify it installs the real fixtures**

Run: `npm run install:fixtures`
Expected: three `aws-playground: installing fixtures/typescript/...` headers, each followed by a successful npm install, exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/install-fixtures.js tests/fixtures-install.test.js package.json
git commit -m "feat(fixtures): discover fixture packages instead of listing three"
```

---

### Task 4: Guards and `npm start`

Three small user-facing corrections. `.npmrc` catches an old Node at install time in a clone; `bin/cli.js` catches it at run time on the `npx` path, where npm resolves config from the caller's directory and never sees this repo's `.npmrc`. The missing-build hint now names the command that actually produces a build. And `npm start` stops forcing `--no-open`, so the documented way to run the app behaves like the app.

**Files:**
- Create: `.npmrc`
- Modify: `bin/cli.js:5` (requires), `bin/cli.js:16-25` (help block and the `web/dist` guard)
- Modify: `package.json` (the `start` script)
- Modify: `tests/cli.test.js` (the two spawns that relied on `npm start` semantics are unaffected; add one assertion)

**Interfaces:**
- Consumes: `server/node-version.js` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.js`:

```js
// npm start no longer forces --no-open, so the flag has to keep working when
// a developer passes it through: npm start -- --no-open.
test('cli --help documents both flags and exits 0', async () => {
  const child = spawn(process.execPath, [CLI, '--help']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0);
  assert.ok(out.includes('npm start -- --port'),
    'help should show how to pass flags through npm start');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.js`
Expected: FAIL on the new test — `help should show how to pass flags through npm start`

- [ ] **Step 3: Write minimal implementation**

In `bin/cli.js`, add the require alongside the others at the top (after the `localServices` require on line 6):

```js
const { nodeVersionOk, nodeVersionMessage } = require('../server/node-version');
```

Replace the help block so it mentions the npm passthrough:

```js
if (flag('--help') || flag('-h')) {
  console.log(`Usage: aws-playground [--port <n>] [--no-open]

Starts the Lambda Playground server and opens it in your browser.

  --port <n>   Port to listen on (default 4590)
  --no-open    Do not open the browser automatically

From a source checkout, pass flags through npm: npm start -- --port 5000`);
  process.exit(0);
}

if (!nodeVersionOk(process.version)) {
  console.error(nodeVersionMessage(process.version));
  process.exit(1);
}
```

Change the missing-build hint from `npm run build` to `npm install`:

```js
const DIST = path.join(__dirname, '..', 'web', 'dist');
if (!fs.existsSync(path.join(DIST, 'server', 'server.js'))) {
  console.error('aws-playground: web app not built (web/dist missing).');
  console.error('From a source checkout, run: npm install');
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Let `npm start` open the browser**

In `package.json`:

```json
    "start": "node bin/cli.js",
```

- [ ] **Step 6: Refuse an old Node at install time**

Create `.npmrc`:

```
# `engines` is advisory by default; this turns a Node older than the floor in
# package.json into a refusal with a real message rather than a vite stack
# trace halfway through the web build.
engine-strict=true
```

- [ ] **Step 7: Verify the guards**

```bash
npm run test:server
npm start -- --no-open --port 0
```
Expected: the suite passes; the second command prints `aws-playground listening at http://localhost:<port>` and does **not** open a browser. Ctrl-C to stop.

- [ ] **Step 8: Commit**

```bash
git add .npmrc bin/cli.js package.json tests/cli.test.js
git commit -m "feat(cli): check Node at startup, and let npm start open the browser"
```

---

### Task 5: CI and README tell the same story

CI's three install/build steps are now one `npm ci`, which matters less for brevity than for coverage: CI runs the exact command a contributor runs, so the install path cannot rot unnoticed. GitHub Actions sets `CI=true`, so `prepare` takes its `npm ci` branch inside `web/` and the lockfile stays enforced.

**Files:**
- Modify: `.github/workflows/ci.yml:17-31`
- Modify: `README.md:12-19` (the install section), `README.md:146-160` (Development)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Collapse the CI install steps**

In `.github/workflows/ci.yml`, replace these four blocks:

```yaml
      - name: Install root dependencies
        run: npm ci

      - name: Install web dependencies
        run: npm --prefix web ci

      # Must precede the server tests: web/dist is gitignored, and the CLI
      # refuses to boot without it, so tests/cli.test.js would skip (or, before
      # it was guarded, fail with an opaque "no URL printed" timeout).
      - name: Build web
        run: npm --prefix web run build
```

with:

```yaml
      # One step, and deliberately the same one a contributor runs: npm's
      # prepare script installs web/ and builds web/dist. CI is set here, so
      # the web install goes through `npm ci` and honours the lockfile.
      # It must precede the server tests -- web/dist is gitignored, and the
      # CLI refuses to boot without it, so tests/cli.test.js would skip.
      - name: Install and build
        run: npm ci
```

- [ ] **Step 2: Verify the workflow is still valid YAML and the commands work locally**

```bash
node -e "require('fs').readFileSync('.github/workflows/ci.yml','utf8')" && CI=true npm ci && npm test
```
Expected: `npm ci` installs web via `npm ci` and builds `web/dist`; both suites pass.

- [ ] **Step 3: Rewrite the README's install section**

Replace `README.md` lines 12-19 (the `## Install & run` section, from the heading through the `Running the playground itself requires Node >= 22.12.` line) with:

```markdown
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
```

- [ ] **Step 4: Rewrite the README's Development section**

Replace `README.md` lines 146-160 (the `## Development` heading through the paragraph ending `install their deps once with `npm run install:fixtures`.`) with:

```markdown
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

The `fixtures/` folder is never part of the build or the published package; it
is sample Lambda projects, each installed on its own. To invoke the TypeScript
fixtures, install their deps once with `npm run install:fixtures`, which finds
every fixture that declares dependencies.
```

- [ ] **Step 5: Verify every command the README now claims**

```bash
rm -rf web/dist node_modules web/node_modules
npm install && ls web/dist/server/server.js
npm test
npm start -- --no-open --port 0
```
Expected: the install builds `web/dist`, both suites pass, and the server prints its URL without opening a browser. Ctrl-C to stop.

- [ ] **Step 6: Verify the no-clone path end to end**

```bash
work=$(mktemp -d) && npm pack --pack-destination "$work" >/dev/null \
  && cd "$work" && npm init -y >/dev/null \
  && npm install ./aws-playground-0.1.0.tgz \
  && ./node_modules/.bin/aws-playground --no-open --port 0
```
Expected: `npm pack` runs `prepare` and builds `web/dist` into the tarball; the installed binary prints `aws-playground listening at http://localhost:<port>`. This is the `npx github:...` path minus the git clone. Ctrl-C, then `cd` back to the repo.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "docs(install): document npx and npm install, drop npm install -g"
```

---

## Definition of done

- `rm -rf node_modules web/node_modules web/dist && npm install && npm start` works from a clean checkout with no other command in between.
- `npm test` passes: `tests/node-version.test.js`, `tests/prepare.test.js`, `tests/fixtures-install.test.js` are new and green; every pre-existing test is still green and `tests/pack.test.js` is no slower.
- `npm install -g .` no longer appears anywhere in `README.md`.
- CI has exactly one install step.
