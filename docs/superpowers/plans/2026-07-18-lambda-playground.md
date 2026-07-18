# Lambda Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, Postman-like web app (installable npm CLI `aws-playground`) for invoking AWS Lambda handlers directly on the host — Python, Node.js, and Java — with no Docker, RIE, SAM, LocalStack, or moto.

**Architecture:** An Express server spawns a fresh per-language harness subprocess per invoke (cold-start semantics). The harness loads the user's handler from a registered project folder, calls it with `(event, context)`, and writes a result envelope to a temp file while stdout/stderr are captured as logs. A static vanilla-JS frontend mimics the AWS console test screen (event editor, Response/Logs/Report tabs).

**Tech Stack:** Node.js ≥18, Express 4 (only runtime dependency), `node:test` for tests, vendored CodeMirror 5 for the JSON event editor, plain Python/Node/Java (+Gson, shaded) for the harnesses.

**Spec:** `docs/superpowers/specs/2026-07-18-lambda-playground-design.md`

## Global Constraints

- Node.js ≥ 18. Server code is CommonJS. Only runtime dependency: `express` (^4.19.2). Tests use built-in `node --test` — no test framework dependency.
- Forbidden everywhere: Docker, AWS RIE, SAM CLI, LocalStack, moto, AWS SDK mocking of any kind.
- Default port **4590**. Data dir `~/.aws-playground/` — **always** overridable via env var `AWS_PLAYGROUND_DATA_DIR`; every test MUST set it to a temp dir before touching the store.
- Defaults: `timeoutMs` 30000, `memoryMb` 128, `AWS_REGION` `us-east-1`, function version `$LATEST`.
- Harness subprocess env = ONLY: `PATH`, `HOME`, `TMPDIR`, `LANG`, `JAVA_HOME` (if set) + `AWS_LAMBDA_FUNCTION_NAME`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_VERSION`, `AWS_REGION` + per-function user env vars (user vars override the AWS defaults). Nothing else may leak from the server's environment.
- Result envelope schema (all harnesses): `{ok: bool, phase: "init"|"invoke", response?: any, error?: {type, message, stackTrace: string[]}, durationMs: number}` written to the file given by `--result-file`. Event JSON arrives on **stdin**. Harness args: `--handler`, `--result-file`, `--timeout-ms`, `--memory-mb`, `--request-id`.
- Handler syntax: Python `module.function` (dots for packages), Node `file.export`, Java `com.example.Class::method` (`::method` optional → defaults to `handleRequest`).
- Tests that need a language runtime MUST auto-skip when it isn't installed (use `tests/helpers.js` → `hasRuntime`).
- Commit style: conventional commits (`feat:`, `test:`, `chore:`, `docs:`).

## File Structure

```
package.json              npm package, bin entry (Task 1)
.gitignore                (Task 1)
server/store.js           registry persistence in $AWS_PLAYGROUND_DATA_DIR/functions.json (Task 1)
server/detect.js          runtime/handler/venv/jar detection (Task 2)
harnesses/python/harness.py   (Task 3)
harnesses/node/harness.mjs    (Task 4)
server/invoker.js         spawn harness, clean env, timeout kill, envelope→result (Task 5)
server/index.js           createApp(): Express routes + static (Task 6)
harnesses/java/Harness.java, build.sh, harness.jar (committed)  (Task 7)
bin/cli.js                CLI entry: flags, listen, open browser (Task 8)
public/index.html, styles.css, app.js, vendor/codemirror/*      (Task 9)
fixtures/python-*, node-hello, java-hello                        (Tasks 3,4,5,7)
tests/*.test.js, tests/helpers.js                                (each task)
README.md                 usage + architecture (Task 10)
```

---

### Task 1: Package scaffold + function registry store

**Files:**
- Create: `package.json`, `.gitignore`, `server/store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Produces: `server/store.js` exports `{ dataDir(), list(), get(id), create(input), update(id, patch), remove(id) }`. A function record is `{id, name, path, runtime, handler, timeoutMs, memoryMb, jarPath, env, savedEvents}` with defaults `handler:''`, `timeoutMs:30000`, `memoryMb:128`, `jarPath:null`, `env:{}`, `savedEvents:[]`. `update` ignores unknown keys and never changes `id`; returns `null` for missing id. `remove` returns boolean. Data lives at `${AWS_PLAYGROUND_DATA_DIR || ~/.aws-playground}/functions.json` as `{"functions":[...]}`.

- [ ] **Step 1: Create package.json and .gitignore**

`package.json`:

```json
{
  "name": "aws-playground",
  "version": "0.1.0",
  "description": "Local Postman-like playground for AWS Lambda handlers - no Docker, no RIE, no SAM",
  "license": "MIT",
  "bin": { "aws-playground": "bin/cli.js" },
  "main": "server/index.js",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node bin/cli.js --no-open",
    "test": "node --test tests/"
  },
  "dependencies": { "express": "^4.19.2" },
  "files": ["bin", "server", "harnesses", "public"]
}
```

`.gitignore`:

```
node_modules/
harnesses/java/gson.jar
harnesses/java/build/
fixtures/java-hello/lambda-core.jar
fixtures/java-hello/build/
```

Run: `npm install` (installs express).

- [ ] **Step 2: Write the failing test**

`tests/store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-store-'));
const store = require('../server/store');

test('create applies defaults and persists to functions.json', () => {
  const fn = store.create({ name: 'fn1', path: '/tmp/fn1', runtime: 'python' });
  assert.ok(fn.id);
  assert.strictEqual(fn.handler, '');
  assert.strictEqual(fn.timeoutMs, 30000);
  assert.strictEqual(fn.memoryMb, 128);
  assert.strictEqual(fn.jarPath, null);
  assert.deepStrictEqual(fn.env, {});
  assert.deepStrictEqual(fn.savedEvents, []);
  const onDisk = JSON.parse(fs.readFileSync(
    path.join(process.env.AWS_PLAYGROUND_DATA_DIR, 'functions.json'), 'utf8'));
  assert.strictEqual(onDisk.functions.length, 1);
  assert.strictEqual(onDisk.functions[0].id, fn.id);
});

test('get, update, remove round-trip', () => {
  const fn = store.create({ name: 'fn2', path: '/tmp/fn2', runtime: 'node' });
  assert.strictEqual(store.get(fn.id).name, 'fn2');
  const updated = store.update(fn.id, { handler: 'index.handler', env: { A: '1' }, id: 'hack', bogus: true });
  assert.strictEqual(updated.handler, 'index.handler');
  assert.deepStrictEqual(updated.env, { A: '1' });
  assert.strictEqual(updated.id, fn.id);
  assert.strictEqual(updated.bogus, undefined);
  assert.strictEqual(store.update('missing', {}), null);
  assert.strictEqual(store.remove(fn.id), true);
  assert.strictEqual(store.remove(fn.id), false);
  assert.strictEqual(store.get(fn.id), null);
});

test('list returns empty array when file missing', () => {
  process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-empty-'));
  assert.deepStrictEqual(store.list().filter(f => f.name === 'nope'), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL with `Cannot find module '../server/store'`

- [ ] **Step 4: Write the implementation**

`server/store.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_KEYS = ['name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'savedEvents'];

function dataDir() {
  return process.env.AWS_PLAYGROUND_DATA_DIR || path.join(os.homedir(), '.aws-playground');
}

function dataFile() {
  return path.join(dataDir(), 'functions.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return { functions: [] };
  }
}

function save(db) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(dataFile(), JSON.stringify(db, null, 2));
}

function list() {
  return load().functions;
}

function get(id) {
  return list().find(f => f.id === id) || null;
}

function create(input) {
  const db = load();
  const fn = {
    id: crypto.randomUUID(),
    name: input.name,
    path: input.path,
    runtime: input.runtime,
    handler: input.handler ?? '',
    timeoutMs: input.timeoutMs ?? 30000,
    memoryMb: input.memoryMb ?? 128,
    jarPath: input.jarPath ?? null,
    env: input.env ?? {},
    savedEvents: input.savedEvents ?? [],
  };
  db.functions.push(fn);
  save(db);
  return fn;
}

function update(id, patch) {
  const db = load();
  const fn = db.functions.find(f => f.id === id);
  if (!fn) return null;
  for (const k of ALLOWED_KEYS) if (k in patch) fn[k] = patch[k];
  save(db);
  return fn;
}

function remove(id) {
  const db = load();
  const i = db.functions.findIndex(f => f.id === id);
  if (i === -1) return false;
  db.functions.splice(i, 1);
  save(db);
  return true;
}

module.exports = { dataDir, list, get, create, update, remove };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/store.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore server/store.js tests/store.test.js
git commit -m "feat: package scaffold and function registry store"
```

---

### Task 2: Project detection

**Files:**
- Create: `server/detect.js`
- Test: `tests/detect.test.js`

**Interfaces:**
- Produces: `server/detect.js` exports `{ detectProject(dir), findVenvPython(dir), findJar(dir) }`.
  - `detectProject(dir)` → `{ runtime: 'python'|'node'|'java'|null, handlerCandidates: string[], venvPython: string|null, jarPath: string|null }`, or `{ error: 'not-a-directory' }` when `dir` doesn't exist / isn't a directory. Runtime priority when ambiguous: python > node > java.
  - `findVenvPython(dir)` → absolute path to `venv|.venv|env` python (checks `bin/python` and `Scripts/python.exe`) or `null`.
  - `findJar(dir)` → first `.jar` in `target/` or `build/libs/` (excluding `-sources`/`-javadoc`) or `null`.

- [ ] **Step 1: Write the failing test**

`tests/detect.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject, findVenvPython, findJar } = require('../server/detect');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-detect-'));
}

test('detects python project with venv and handler candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'),
    'def handler(event, context):\n    return {}\n\ndef helper(x):\n    return x\n');
  fs.mkdirSync(path.join(dir, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv', 'bin', 'python'), '');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'python');
  assert.deepStrictEqual(res.handlerCandidates, ['app.handler']);
  assert.strictEqual(res.venvPython, path.join(dir, 'venv', 'bin', 'python'));
  assert.strictEqual(res.jarPath, null);
});

test('detects node project and export candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.js'),
    'exports.handler = async (event, context) => ({});\n');
  fs.writeFileSync(path.join(dir, 'other.mjs'),
    'export async function run(event, context) { return {}; }\n');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.ok(res.handlerCandidates.includes('index.handler'));
  assert.ok(res.handlerCandidates.includes('other.run'));
});

test('detects java project via built jar', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'target'));
  fs.writeFileSync(path.join(dir, 'target', 'app-1.0.jar'), '');
  fs.writeFileSync(path.join(dir, 'target', 'app-1.0-sources.jar'), '');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'java');
  assert.strictEqual(res.jarPath, path.join(dir, 'target', 'app-1.0.jar'));
  assert.strictEqual(findJar(dir), path.join(dir, 'target', 'app-1.0.jar'));
});

test('returns error for a non-directory', () => {
  assert.deepStrictEqual(detectProject('/no/such/dir/xyz'), { error: 'not-a-directory' });
});

test('findVenvPython returns null when absent', () => {
  assert.strictEqual(findVenvPython(tmpDir()), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/detect.test.js`
Expected: FAIL with `Cannot find module '../server/detect'`

- [ ] **Step 3: Write the implementation**

`server/detect.js`:

```js
const fs = require('fs');
const path = require('path');

function findVenvPython(dir) {
  for (const v of ['venv', '.venv', 'env']) {
    for (const rel of [path.join(v, 'bin', 'python'), path.join(v, 'Scripts', 'python.exe')]) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findJar(dir) {
  for (const sub of ['target', path.join('build', 'libs')]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    const jars = fs.readdirSync(d).filter(f =>
      f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
    if (jars.length) return path.join(d, jars.sort()[0]);
  }
  return null;
}

function pythonHandlerCandidates(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(\s*event\s*,\s*context\b/gm)) {
      out.push(`${f.slice(0, -3)}.${m[1]}`);
    }
  }
  return out;
}

function nodeHandlerCandidates(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(m?js|cjs)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const base = f.replace(/\.(m?js|cjs)$/, '');
    const re = /(?:exports\.([A-Za-z_]\w*)\s*=|export\s+(?:const|async\s+function|function)\s+([A-Za-z_]\w*))/g;
    for (const m of src.matchAll(re)) out.push(`${base}.${m[1] || m[2]}`);
  }
  return out;
}

function detectProject(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { error: 'not-a-directory' };
  }
  const venvPython = findVenvPython(dir);
  const jarPath = findJar(dir);
  const files = fs.readdirSync(dir);
  let runtime = null;
  if (files.some(f => f.endsWith('.py'))) runtime = 'python';
  else if (files.some(f => /\.(m?js|cjs)$/.test(f)) || files.includes('package.json')) runtime = 'node';
  else if (jarPath || files.includes('pom.xml') || files.includes('build.gradle')) runtime = 'java';
  const handlerCandidates =
    runtime === 'python' ? pythonHandlerCandidates(dir) :
    runtime === 'node' ? nodeHandlerCandidates(dir) : [];
  return { runtime, handlerCandidates, venvPython, jarPath };
}

module.exports = { detectProject, findVenvPython, findJar };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/detect.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/detect.js tests/detect.test.js
git commit -m "feat: project runtime/handler/venv/jar detection"
```

---

### Task 3: Python harness + Python fixtures

**Files:**
- Create: `harnesses/python/harness.py`, `fixtures/python-hello/app.py`, `fixtures/python-error/app.py`, `fixtures/python-timeout/app.py`, `fixtures/python-env-echo/app.py`, `fixtures/python-crash/app.py`, `tests/helpers.js`
- Test: `tests/harness-python.test.js`

**Interfaces:**
- Consumes: envelope schema + harness CLI args from Global Constraints.
- Produces: `harnesses/python/harness.py` — run with cwd = project dir; writes envelope to `--result-file`. Context object exposes `aws_request_id`, `function_name`, `function_version`, `memory_limit_in_mb`, `invoked_function_arn`, `log_group_name`, `log_stream_name`, `get_remaining_time_in_millis()`. `tests/helpers.js` exports `{ hasRuntime(cmd, args?) }` used by all runtime-dependent tests.

- [ ] **Step 1: Create the fixtures**

`fixtures/python-hello/app.py`:

```python
def handler(event, context):
    print("hello log line")
    return {
        "message": "hello from python",
        "echo": event,
        "requestId": context.aws_request_id,
        "remaining": context.get_remaining_time_in_millis() > 0,
    }
```

`fixtures/python-error/app.py`:

```python
def handler(event, context):
    raise ValueError("boom from python")
```

`fixtures/python-timeout/app.py`:

```python
import time

def handler(event, context):
    time.sleep(30)
    return {"never": True}
```

`fixtures/python-env-echo/app.py`:

```python
import os

def handler(event, context):
    return {
        "region": os.environ.get("AWS_REGION"),
        "fnName": os.environ.get("AWS_LAMBDA_FUNCTION_NAME"),
        "custom": os.environ.get("CUSTOM_VAR"),
        "leak": os.environ.get("SHOULD_NOT_LEAK"),
    }
```

`fixtures/python-crash/app.py`:

```python
import sys

def handler(event, context):
    print("about to exit hard")
    sys.exit(3)
```

`tests/helpers.js`:

```js
const { execFileSync } = require('node:child_process');

function hasRuntime(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { hasRuntime };
```

- [ ] **Step 2: Write the failing test**

`tests/harness-python.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'python', 'harness.py');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const skip = !hasRuntime('python3');

function runHarness({ fixture, handler, event = {}, env = {} }) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile('python3',
      [HARNESS, '--handler', handler, '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-test-1'],
      { cwd: path.join(FIXTURES, fixture),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
      (err, stdout, stderr) => {
        let envelope = null;
        try {
          envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          fs.unlinkSync(resultFile);
        } catch {}
        resolve({ envelope, stdout, stderr });
      });
    child.stdin.end(JSON.stringify(event));
  });
}

test('happy path returns envelope, context, and captures print logs', { skip }, async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'python-hello', handler: 'app.handler', event: { a: 1 } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.response.message, 'hello from python');
  assert.deepStrictEqual(envelope.response.echo, { a: 1 });
  assert.strictEqual(envelope.response.requestId, 'req-test-1');
  assert.strictEqual(envelope.response.remaining, true);
  assert.ok(envelope.durationMs >= 0);
  assert.ok(stdout.includes('hello log line'));
});

test('handler exception -> ok:false phase:invoke with stack trace', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python-error', handler: 'app.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'ValueError');
  assert.strictEqual(envelope.error.message, 'boom from python');
  assert.ok(envelope.error.stackTrace.length > 0);
});

test('missing module -> phase:init', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python-hello', handler: 'nope.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
});

test('malformed handler string -> phase:init', { skip }, async () => {
  const { envelope } = await runHarness({ fixture: 'python-hello', handler: 'nodots' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.MalformedHandlerName');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/harness-python.test.js`
Expected: FAIL (harness.py does not exist, so python3 exits non-zero and `envelope` is null → TypeError reading `.ok`). If python3 is not installed the tests SKIP — install python3 to proceed.

- [ ] **Step 4: Write the implementation**

`harnesses/python/harness.py`:

```python
"""AWS Lambda Playground python harness.

Run with cwd = the user's project directory. Reads the event JSON from
stdin, loads <module>.<function> from the handler string, invokes it with
(event, context), and writes a result envelope to --result-file. All user
stdout/stderr passes through and is captured by the server as logs.
"""
import argparse
import importlib
import json
import os
import sys
import time
import traceback
import uuid


def write_result(path, payload):
    with open(path, "w") as f:
        json.dump(payload, f)


class Context:
    def __init__(self, timeout_ms, memory_mb, request_id):
        self._deadline = time.monotonic() + timeout_ms / 1000.0
        self.function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "playground")
        self.function_version = os.environ.get("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST")
        self.memory_limit_in_mb = memory_mb
        self.aws_request_id = request_id
        self.invoked_function_arn = "arn:aws:lambda:%s:000000000000:function:%s" % (
            os.environ.get("AWS_REGION", "us-east-1"), self.function_name)
        self.log_group_name = "/aws/lambda/" + self.function_name
        self.log_stream_name = "playground"

    def get_remaining_time_in_millis(self):
        return max(0, int((self._deadline - time.monotonic()) * 1000))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--handler", required=True)
    p.add_argument("--result-file", required=True)
    p.add_argument("--timeout-ms", type=int, default=30000)
    p.add_argument("--memory-mb", type=int, default=128)
    p.add_argument("--request-id", default=str(uuid.uuid4()))
    args = p.parse_args()

    sys.path.insert(0, os.getcwd())
    event = json.load(sys.stdin)

    module_name, _, func_name = args.handler.rpartition(".")
    if not module_name:
        write_result(args.result_file, {
            "ok": False, "phase": "init", "durationMs": 0,
            "error": {"type": "Runtime.MalformedHandlerName",
                      "message": "Bad handler '%s': expected 'module.function'" % args.handler,
                      "stackTrace": []}})
        return
    try:
        module = importlib.import_module(module_name)
        func = getattr(module, func_name)
    except Exception as e:
        write_result(args.result_file, {
            "ok": False, "phase": "init", "durationMs": 0,
            "error": {"type": type(e).__name__, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}})
        return

    ctx = Context(args.timeout_ms, args.memory_mb, args.request_id)
    start = time.monotonic()
    try:
        response = func(event, ctx)
        duration = (time.monotonic() - start) * 1000
        json.dumps(response)  # raises TypeError if not JSON-serializable
        write_result(args.result_file, {
            "ok": True, "phase": "invoke",
            "response": response, "durationMs": duration})
    except Exception as e:
        duration = (time.monotonic() - start) * 1000
        write_result(args.result_file, {
            "ok": False, "phase": "invoke", "durationMs": duration,
            "error": {"type": type(e).__name__, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}})


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/harness-python.test.js`
Expected: PASS (4 tests, or 4 skipped if python3 missing)

- [ ] **Step 6: Commit**

```bash
git add harnesses/python/harness.py fixtures/python-hello fixtures/python-error fixtures/python-timeout fixtures/python-env-echo fixtures/python-crash tests/helpers.js tests/harness-python.test.js
git commit -m "feat: python harness and python fixtures"
```

---

### Task 4: Node harness + Node fixture

**Files:**
- Create: `harnesses/node/harness.mjs`, `fixtures/node-hello/index.js`
- Test: `tests/harness-node.test.js`

**Interfaces:**
- Consumes: envelope schema + harness CLI args from Global Constraints.
- Produces: `harnesses/node/harness.mjs` — resolves `file.export` against cwd trying `.mjs`, `.js`, `.cjs`; supports async handlers, sync-return handlers, and 3-arg callback handlers. Context object exposes camelCase properties: `awsRequestId`, `functionName`, `functionVersion`, `memoryLimitInMB` (string), `invokedFunctionArn`, `logGroupName`, `logStreamName`, `getRemainingTimeInMillis()`.

- [ ] **Step 1: Create the fixture**

`fixtures/node-hello/index.js`:

```js
exports.handler = async (event, context) => {
  console.log('node log line');
  return {
    message: 'hello from node',
    echo: event,
    requestId: context.awsRequestId,
    remaining: context.getRemainingTimeInMillis() > 0,
  };
};

exports.callbackHandler = (event, context, callback) => {
  setTimeout(() => callback(null, { message: 'hello from callback' }), 10);
};

exports.errorHandler = async () => {
  throw new TypeError('boom from node');
};
```

- [ ] **Step 2: Write the failing test**

`tests/harness-node.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HARNESS = path.join(__dirname, '..', 'harnesses', 'node', 'harness.mjs');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function runHarness({ fixture, handler, event = {} }) {
  return new Promise((resolve) => {
    const resultFile = path.join(os.tmpdir(), `hn-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const child = execFile(process.execPath,
      [HARNESS, '--handler', handler, '--result-file', resultFile,
       '--timeout-ms', '30000', '--memory-mb', '128', '--request-id', 'req-test-2'],
      { cwd: path.join(FIXTURES, fixture),
        env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, stdout, stderr) => {
        let envelope = null;
        try {
          envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          fs.unlinkSync(resultFile);
        } catch {}
        resolve({ envelope, stdout, stderr });
      });
    child.stdin.end(JSON.stringify(event));
  });
}

test('async handler happy path with context and logs', async () => {
  const { envelope, stdout } = await runHarness({
    fixture: 'node-hello', handler: 'index.handler', event: { b: 2 } });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.response.message, 'hello from node');
  assert.deepStrictEqual(envelope.response.echo, { b: 2 });
  assert.strictEqual(envelope.response.requestId, 'req-test-2');
  assert.strictEqual(envelope.response.remaining, true);
  assert.ok(stdout.includes('node log line'));
});

test('callback-style handler resolves via callback', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.callbackHandler' });
  assert.strictEqual(envelope.ok, true);
  assert.strictEqual(envelope.response.message, 'hello from callback');
});

test('thrown error -> ok:false phase:invoke', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.errorHandler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'invoke');
  assert.strictEqual(envelope.error.type, 'TypeError');
  assert.strictEqual(envelope.error.message, 'boom from node');
});

test('missing file -> phase:init Runtime.ImportModuleError', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'missing.handler' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.ImportModuleError');
});

test('missing export -> phase:init Runtime.HandlerNotFound', async () => {
  const { envelope } = await runHarness({ fixture: 'node-hello', handler: 'index.nope' });
  assert.strictEqual(envelope.ok, false);
  assert.strictEqual(envelope.phase, 'init');
  assert.strictEqual(envelope.error.type, 'Runtime.HandlerNotFound');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/harness-node.test.js`
Expected: FAIL (harness.mjs missing → envelope null → TypeError reading `.ok`)

- [ ] **Step 4: Write the implementation**

`harnesses/node/harness.mjs`:

```js
// AWS Lambda Playground node harness. Run with cwd = the user's project
// directory. Reads event JSON from stdin, imports <file>.<export>, invokes
// it with (event, context[, callback]), writes an envelope to --result-file.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const resultFile = arg('--result-file');
const handlerSpec = arg('--handler', '');
const timeoutMs = parseInt(arg('--timeout-ms', '30000'), 10);
const memoryMb = parseInt(arg('--memory-mb', '128'), 10);
const requestId = arg('--request-id', randomUUID());

function writeResult(payload) {
  fs.writeFileSync(resultFile, JSON.stringify(payload));
}

function shape(err) {
  return {
    type: err?.name || 'Error',
    message: err?.message || String(err),
    stackTrace: (err?.stack || '').split('\n'),
  };
}

function namedError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const event = JSON.parse(fs.readFileSync(0, 'utf8'));

const dot = handlerSpec.lastIndexOf('.');
let fn;
try {
  if (dot <= 0) throw namedError('Runtime.MalformedHandlerName',
    `Bad handler '${handlerSpec}': expected 'file.export'`);
  const filePart = handlerSpec.slice(0, dot);
  const exportName = handlerSpec.slice(dot + 1);
  const base = path.resolve(process.cwd(), filePart);
  const candidate = ['.mjs', '.js', '.cjs'].map(e => base + e).find(f => fs.existsSync(f));
  if (!candidate) throw namedError('Runtime.ImportModuleError',
    `Cannot find module file for '${filePart}' (tried .mjs, .js, .cjs)`);
  const mod = await import(pathToFileURL(candidate).href);
  fn = mod[exportName] ?? mod.default?.[exportName];
  if (typeof fn !== 'function') throw namedError('Runtime.HandlerNotFound',
    `Handler '${exportName}' is not an exported function in ${candidate}`);
} catch (err) {
  writeResult({ ok: false, phase: 'init', durationMs: 0, error: shape(err) });
  process.exit(0);
}

const deadline = Date.now() + timeoutMs;
const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'playground';
const context = {
  functionName,
  functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
  memoryLimitInMB: String(memoryMb),
  awsRequestId: requestId,
  invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION || 'us-east-1'}:000000000000:function:${functionName}`,
  logGroupName: `/aws/lambda/${functionName}`,
  logStreamName: 'playground',
  getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
};

const start = process.hrtime.bigint();
try {
  const response = await new Promise((resolve, reject) => {
    const maybe = fn(event, context, (err, res) => (err ? reject(err) : resolve(res)));
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    else if (fn.length < 3) resolve(maybe);
    // else: 3-arg callback style — wait for the callback
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  writeResult({ ok: true, phase: 'invoke', response: response ?? null, durationMs });
} catch (err) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  writeResult({ ok: false, phase: 'invoke', durationMs, error: shape(err) });
}
process.exit(0);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/harness-node.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add harnesses/node/harness.mjs fixtures/node-hello tests/harness-node.test.js
git commit -m "feat: node harness and node fixture"
```

---

### Task 5: Invoker — spawn, clean env, timeout kill, envelope handling

**Files:**
- Create: `server/invoker.js`
- Test: `tests/invoker.test.js`

**Interfaces:**
- Consumes: `findVenvPython` from `server/detect.js`; harnesses from Tasks 3–4 (Java branch is written here too, tested in Task 7).
- Produces: `server/invoker.js` exports `{ invoke(opts) }` where `opts = { name, dir, runtime, handler, event, env?, timeoutMs?, memoryMb?, jarPath? }`. Resolves to `{ ok, phase, response?, error?, logs: string, report: { requestId, durationMs, billedMs, memoryMb, timedOut } }`. Never rejects for handler/user failures — only throws on unknown `runtime`. Timeout error: `type 'Sandbox.Timedout'`, message `Task timed out after N.NN seconds`. Missing envelope: `type 'Runtime.ExitError'`. Spawn failure (interpreter missing): `type 'Runtime.Unavailable'`, `phase 'init'`.

- [ ] **Step 1: Write the failing test**

`tests/invoker.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { invoke } = require('../server/invoker');
const { hasRuntime } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');

function base(fixture, extra = {}) {
  return {
    name: 'test-fn',
    dir: path.join(FIXTURES, fixture),
    runtime: 'python',
    handler: 'app.handler',
    event: {},
    ...extra,
  };
}

test('python happy path: response, logs, report', { skip: noPy }, async () => {
  const r = await invoke(base('python-hello', { event: { x: 1 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from python');
  assert.deepStrictEqual(r.response.echo, { x: 1 });
  assert.ok(r.logs.includes('hello log line'));
  assert.ok(r.report.requestId.length > 10);
  assert.ok(r.report.durationMs >= 0);
  assert.ok(r.report.billedMs >= 1);
  assert.strictEqual(r.report.memoryMb, 128);
  assert.strictEqual(r.report.timedOut, false);
});

test('handler exception surfaces lambda-style error', { skip: noPy }, async () => {
  const r = await invoke(base('python-error'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'invoke');
  assert.strictEqual(r.error.type, 'ValueError');
  assert.strictEqual(r.error.message, 'boom from python');
});

test('timeout kills the process and reports Task timed out', { skip: noPy }, async () => {
  const r = await invoke(base('python-timeout', { timeoutMs: 1000 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Sandbox.Timedout');
  assert.strictEqual(r.error.message, 'Task timed out after 1.00 seconds');
  assert.strictEqual(r.report.timedOut, true);
});

test('env: AWS defaults set, user vars override, host env does not leak', { skip: noPy }, async () => {
  process.env.SHOULD_NOT_LEAK = 'secret';
  const r = await invoke(base('python-env-echo', {
    env: { CUSTOM_VAR: '42', AWS_REGION: 'eu-west-1' } }));
  delete process.env.SHOULD_NOT_LEAK;
  assert.strictEqual(r.response.region, 'eu-west-1');
  assert.strictEqual(r.response.fnName, 'test-fn');
  assert.strictEqual(r.response.custom, '42');
  assert.strictEqual(r.response.leak, null);
});

test('process exit without envelope -> Runtime.ExitError with logs', { skip: noPy }, async () => {
  const r = await invoke(base('python-crash'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.type, 'Runtime.ExitError');
  assert.ok(r.error.message.includes('exit code 3'));
  assert.ok(r.logs.includes('about to exit hard'));
});

test('node runtime works through the invoker', async () => {
  const r = await invoke(base('node-hello', { runtime: 'node', handler: 'index.handler' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from node');
});

test('unknown runtime throws', async () => {
  await assert.rejects(() => invoke(base('python-hello', { runtime: 'ruby' })),
    /Unknown runtime/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invoker.test.js`
Expected: FAIL with `Cannot find module '../server/invoker'`

- [ ] **Step 3: Write the implementation**

`server/invoker.js`:

```js
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVenvPython } = require('./detect');

const HARNESS_DIR = path.join(__dirname, '..', 'harnesses');
const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'JAVA_HOME'];

function command(opts, harnessArgs) {
  if (opts.runtime === 'python') {
    const interp = findVenvPython(opts.dir) || 'python3';
    return { cmd: interp, args: [path.join(HARNESS_DIR, 'python', 'harness.py'), ...harnessArgs] };
  }
  if (opts.runtime === 'node') {
    return { cmd: process.execPath, args: [path.join(HARNESS_DIR, 'node', 'harness.mjs'), ...harnessArgs] };
  }
  if (opts.runtime === 'java') {
    const harnessJar = path.join(HARNESS_DIR, 'java', 'harness.jar');
    const cp = [harnessJar, opts.jarPath].filter(Boolean).join(path.delimiter);
    return { cmd: 'java', args: ['-cp', cp, 'Harness', ...harnessArgs] };
  }
  throw new Error(`Unknown runtime: ${opts.runtime}`);
}

function buildEnv(opts, memoryMb) {
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.AWS_LAMBDA_FUNCTION_NAME = opts.name || 'playground';
  env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = String(memoryMb);
  env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  env.AWS_REGION = 'us-east-1';
  Object.assign(env, opts.env || {});
  return env;
}

async function invoke(opts) {
  const requestId = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryMb = opts.memoryMb ?? 128;
  const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
  const harnessArgs = ['--handler', opts.handler, '--result-file', resultFile,
    '--timeout-ms', String(timeoutMs), '--memory-mb', String(memoryMb),
    '--request-id', requestId];
  const { cmd, args } = command(opts, harnessArgs);
  const env = buildEnv(opts, memoryMb);

  const startedAt = Date.now();
  const run = await new Promise((resolve) => {
    let logs = '';
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.dir, env, detached: process.platform !== 'win32' });
    child.on('error', (err) => resolve({ exit: null, logs, timedOut, spawnError: err }));
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(opts.event ?? {}));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, logs, timedOut }); });
  });
  const wallMs = Date.now() - startedAt;

  let envelope = null;
  try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  try { fs.unlinkSync(resultFile); } catch {}

  let out;
  if (run.timedOut) {
    out = { ok: false, phase: 'invoke', error: {
      type: 'Sandbox.Timedout',
      message: `Task timed out after ${(timeoutMs / 1000).toFixed(2)} seconds`,
      stackTrace: [] } };
  } else if (run.spawnError) {
    out = { ok: false, phase: 'init', error: {
      type: 'Runtime.Unavailable',
      message: `Could not start '${cmd}': ${run.spawnError.message}. Is the ${opts.runtime} runtime installed?`,
      stackTrace: [] } };
  } else if (!envelope) {
    out = { ok: false, phase: 'invoke', error: {
      type: 'Runtime.ExitError',
      message: `Runtime exited without providing a result (exit code ${run.exit})`,
      stackTrace: [] } };
  } else {
    out = { ok: envelope.ok, phase: envelope.phase,
      response: envelope.response, error: envelope.error };
  }

  const durationMs = envelope?.durationMs ?? wallMs;
  out.logs = run.logs;
  out.report = {
    requestId,
    durationMs: Math.round(durationMs * 100) / 100,
    billedMs: Math.max(1, Math.ceil(durationMs)),
    memoryMb,
    timedOut: run.timedOut,
  };
  return out;
}

module.exports = { invoke };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invoker.test.js`
Expected: PASS (7 tests; the timeout test takes ~1s)

- [ ] **Step 5: Commit**

```bash
git add server/invoker.js tests/invoker.test.js
git commit -m "feat: invoker with clean env, timeout kill, and envelope handling"
```

---

### Task 6: HTTP API

**Files:**
- Create: `server/index.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `store` (Task 1), `detectProject`/`findJar` (Task 2), `invoke` (Task 5).
- Produces: `server/index.js` exports `{ createApp }`. Routes:
  - `GET /api/health` → `{ runtimes: { python: {available, version}, node: {...}, java: {...} } }`
  - `GET /api/functions` → `{ functions: [...] }`
  - `POST /api/functions` → 201 + record; 400 `{error}` when name/path/runtime missing, runtime not python|node|java, or path not a directory
  - `PATCH /api/functions/:id` → record or 404; `DELETE /api/functions/:id` → 204 or 404
  - `POST /api/detect` body `{path}` → `detectProject` result
  - `POST /api/invoke` body `{functionId, event, handler?, envVars?, timeoutMs?, memoryMb?}` → invoker result; 404 unknown id; **409** `{error}` if that function already has an invoke in flight. `envVars` are merged over the stored `fn.env`. `jarPath` = stored `fn.jarPath` or `findJar(fn.path)`.
  - Serves `public/` statically at `/`.

- [ ] **Step 1: Write the failing test**

`tests/api.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-api-'));
const { createApp } = require('../server/index');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const noPy = !hasRuntime('python3');
let server, baseUrl;

before(() => new Promise((resolve) => {
  server = createApp().listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

async function req(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

test('health reports runtimes', async () => {
  const { status, body } = await req('GET', '/api/health');
  assert.strictEqual(status, 200);
  assert.ok('python' in body.runtimes);
  assert.ok('node' in body.runtimes);
  assert.ok('java' in body.runtimes);
  assert.strictEqual(body.runtimes.node.available, true);
});

test('function CRUD with validation', async () => {
  let r = await req('POST', '/api/functions', { name: 'x' });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/functions', { name: 'x', path: FIXTURES, runtime: 'ruby' });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/functions', { name: 'x', path: '/no/such/dir', runtime: 'python' });
  assert.strictEqual(r.status, 400);

  r = await req('POST', '/api/functions',
    { name: 'hello', path: path.join(FIXTURES, 'python-hello'), runtime: 'python', handler: 'app.handler' });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;

  r = await req('GET', '/api/functions');
  assert.ok(r.body.functions.some(f => f.id === id));

  r = await req('PATCH', `/api/functions/${id}`, { timeoutMs: 5000 });
  assert.strictEqual(r.body.timeoutMs, 5000);
  r = await req('PATCH', '/api/functions/missing', {});
  assert.strictEqual(r.status, 404);

  r = await req('DELETE', `/api/functions/${id}`);
  assert.strictEqual(r.status, 204);
  r = await req('DELETE', `/api/functions/${id}`);
  assert.strictEqual(r.status, 404);
});

test('detect endpoint', async () => {
  const { body } = await req('POST', '/api/detect', { path: path.join(FIXTURES, 'python-hello') });
  assert.strictEqual(body.runtime, 'python');
  assert.deepStrictEqual(body.handlerCandidates, ['app.handler']);
});

test('invoke via API returns result; unknown id 404', { skip: noPy }, async () => {
  const created = await req('POST', '/api/functions',
    { name: 'hello2', path: path.join(FIXTURES, 'python-hello'), runtime: 'python', handler: 'app.handler' });
  const r = await req('POST', '/api/invoke', { functionId: created.body.id, event: { q: 7 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.response.echo, { q: 7 });
  assert.ok(r.body.report.requestId);
  const nf = await req('POST', '/api/invoke', { functionId: 'missing', event: {} });
  assert.strictEqual(nf.status, 404);
});

test('second concurrent invoke of same function -> 409', { skip: noPy }, async () => {
  const created = await req('POST', '/api/functions',
    { name: 'slow', path: path.join(FIXTURES, 'python-timeout'), runtime: 'python',
      handler: 'app.handler', timeoutMs: 3000 });
  const first = req('POST', '/api/invoke', { functionId: created.body.id, event: {} });
  await new Promise(r => setTimeout(r, 300));
  const second = await req('POST', '/api/invoke', { functionId: created.body.id, event: {} });
  assert.strictEqual(second.status, 409);
  const done = await first;
  assert.strictEqual(done.body.error.type, 'Sandbox.Timedout');
});

test('serves the frontend statically', async () => {
  const res = await fetch(baseUrl + '/');
  assert.strictEqual(res.status, 200);
});
```

- [ ] **Step 2: Create a placeholder frontend so the static test can pass**

`public/index.html` (replaced fully in Task 9):

```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Lambda Playground</title></head>
<body>Lambda Playground</body></html>
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/api.test.js`
Expected: FAIL with `Cannot find module '../server/index'`

- [ ] **Step 4: Write the implementation**

`server/index.js`:

```js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject, findJar } = require('./detect');
const { invoke } = require('./invoker');

const RUNTIMES = ['python', 'node', 'java'];

function checkRuntime(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const inFlight = new Set();

  app.get('/api/health', async (req, res) => {
    const [python, node, java] = await Promise.all([
      checkRuntime('python3', ['--version']),
      checkRuntime('node', ['--version']),
      checkRuntime('java', ['-version']),
    ]);
    res.json({ runtimes: { python, node, java } });
  });

  app.get('/api/functions', (req, res) => res.json({ functions: store.list() }));

  app.post('/api/functions', (req, res) => {
    const { name, path: dir, runtime } = req.body || {};
    if (!name || !dir || !runtime) {
      return res.status(400).json({ error: 'name, path and runtime are required' });
    }
    if (!RUNTIMES.includes(runtime)) {
      return res.status(400).json({ error: `unsupported runtime '${runtime}'` });
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: `path is not a directory: ${dir}` });
    }
    res.status(201).json(store.create(req.body));
  });

  app.patch('/api/functions/:id', (req, res) => {
    const fn = store.update(req.params.id, req.body || {});
    if (!fn) return res.status(404).json({ error: 'function not found' });
    res.json(fn);
  });

  app.delete('/api/functions/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'function not found' });
    res.status(204).end();
  });

  app.post('/api/detect', (req, res) => {
    const dir = (req.body || {}).path;
    if (!dir) return res.status(400).json({ error: 'path is required' });
    res.json(detectProject(dir));
  });

  app.post('/api/invoke', async (req, res) => {
    const { functionId } = req.body || {};
    const fn = store.get(functionId);
    if (!fn) return res.status(404).json({ error: 'function not found' });
    if (inFlight.has(fn.id)) {
      return res.status(409).json({ error: 'an invoke is already in flight for this function' });
    }
    inFlight.add(fn.id);
    try {
      const result = await invoke({
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: req.body.handler ?? fn.handler,
        event: req.body.event ?? {},
        env: { ...fn.env, ...(req.body.envVars || {}) },
        timeoutMs: req.body.timeoutMs ?? fn.timeoutMs,
        memoryMb: req.body.memoryMb ?? fn.memoryMb,
        jarPath: fn.jarPath || findJar(fn.path),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      inFlight.delete(fn.id);
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/api.test.js`
Expected: PASS (6 tests; the 409 test takes ~3s)

- [ ] **Step 6: Commit**

```bash
git add server/index.js public/index.html tests/api.test.js
git commit -m "feat: HTTP API with health, CRUD, detect, and invoke routes"
```

---

### Task 7: Java harness + Java fixture

**Files:**
- Create: `harnesses/java/Harness.java`, `harnesses/java/build.sh`, `harnesses/java/harness.jar` (built artifact, committed), `fixtures/java-hello/src/example/Hello.java`, `fixtures/java-hello/build.sh`, `fixtures/java-hello/target/java-hello.jar` (built artifact, committed)
- Test: `tests/java.test.js`

**Interfaces:**
- Consumes: envelope schema + harness CLI args; `invoke` from Task 5 (its java branch runs `java -cp harness.jar<sep>userJar Harness <args>`).
- Produces: `harnesses/java/harness.jar` — main class `Harness` (default package). Handler spec `pkg.Class::method` or `pkg.Class` (default method `handleRequest`). Supports instance and static methods with signatures `(T, Context)`, `(T)`, or `(InputStream, OutputStream, Context)`. `Context` and its `getLogger()` are `java.lang.reflect.Proxy` objects built against the interfaces found in the *user's* jar, so the harness has no compile-time AWS dependency; the logger's `log(...)` writes to stdout. Event↔POJO mapping via Gson (shaded into harness.jar).

- [ ] **Step 1: Write the Java harness source**

`harnesses/java/Harness.java`:

```java
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * AWS Lambda Playground java harness. Run with cwd = the user's project dir
 * and classpath = harness.jar + the user's built (fat) jar. Reads event JSON
 * from stdin, finds the handler via reflection, invokes it, and writes an
 * envelope to --result-file. Context/LambdaLogger are dynamic proxies over
 * the interfaces in the user's jar, so no AWS libraries are compiled in.
 */
public class Harness {
    static final Gson GSON = new GsonBuilder().serializeNulls().create();

    public static void main(String[] argv) throws Exception {
        Map<String, String> args = parseArgs(argv);
        String resultFile = args.get("--result-file");
        String handlerSpec = args.getOrDefault("--handler", "");
        long timeoutMs = Long.parseLong(args.getOrDefault("--timeout-ms", "30000"));
        int memoryMb = Integer.parseInt(args.getOrDefault("--memory-mb", "128"));
        String requestId = args.getOrDefault("--request-id", UUID.randomUUID().toString());

        String eventJson = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);

        String className = handlerSpec;
        String methodName = "handleRequest";
        int sep = handlerSpec.indexOf("::");
        if (sep != -1) {
            className = handlerSpec.substring(0, sep);
            methodName = handlerSpec.substring(sep + 2);
        }

        Object target = null;
        Method method;
        try {
            if (className.isEmpty()) throw new IllegalArgumentException(
                "Bad handler '" + handlerSpec + "': expected 'pkg.Class::method'");
            Class<?> cls = Class.forName(className);
            method = findMethod(cls, methodName);
            if (!Modifier.isStatic(method.getModifiers())) {
                target = cls.getDeclaredConstructor().newInstance();
            }
        } catch (Throwable t) {
            writeResult(resultFile, envelope(false, "init", null, error(t), 0));
            return;
        }

        long deadline = System.currentTimeMillis() + timeoutMs;
        Class<?>[] pts = method.getParameterTypes();
        long start = System.nanoTime();
        try {
            Object responseTree;
            if (pts.length == 3 && InputStream.class.isAssignableFrom(pts[0])) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                method.invoke(target,
                    new ByteArrayInputStream(eventJson.getBytes(StandardCharsets.UTF_8)),
                    out, makeContext(pts[2], requestId, deadline, memoryMb));
                String body = out.toString(StandardCharsets.UTF_8);
                responseTree = body.isEmpty() ? null : GSON.fromJson(body, Object.class);
            } else {
                Object eventObj = GSON.fromJson(eventJson, pts[0]);
                Object result;
                if (pts.length == 2) {
                    result = method.invoke(target, eventObj,
                        makeContext(pts[1], requestId, deadline, memoryMb));
                } else if (pts.length == 1) {
                    result = method.invoke(target, eventObj);
                } else {
                    throw new IllegalArgumentException("Unsupported handler signature: " + method);
                }
                responseTree = result == null ? null : GSON.toJsonTree(result);
            }
            double durationMs = (System.nanoTime() - start) / 1e6;
            writeResult(resultFile, envelope(true, "invoke", responseTree, null, durationMs));
        } catch (Throwable t) {
            double durationMs = (System.nanoTime() - start) / 1e6;
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException
                && t.getCause() != null ? t.getCause() : t;
            writeResult(resultFile, envelope(false, "invoke", null, error(cause), durationMs));
        }
    }

    static Method findMethod(Class<?> cls, String name) {
        List<Method> named = new ArrayList<>();
        for (Method m : cls.getMethods()) {
            if (m.getName().equals(name) && !m.isBridge() && !m.isSynthetic()
                && m.getParameterCount() >= 1 && m.getParameterCount() <= 3) {
                named.add(m);
            }
        }
        if (named.isEmpty()) throw new IllegalArgumentException(
            "No public method '" + name + "' with 1-3 parameters on " + cls.getName());
        // Prefer the most specific (non-Object first parameter).
        for (Method m : named) if (m.getParameterTypes()[0] != Object.class) return m;
        return named.get(0);
    }

    static Object makeContext(Class<?> ctxIface, String requestId, long deadline, int memoryMb) {
        if (!ctxIface.isInterface()) return null;
        String fnName = env("AWS_LAMBDA_FUNCTION_NAME", "playground");
        Map<String, Object> values = new HashMap<>();
        values.put("getAwsRequestId", requestId);
        values.put("getFunctionName", fnName);
        values.put("getFunctionVersion", env("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST"));
        values.put("getMemoryLimitInMB", memoryMb);
        values.put("getLogGroupName", "/aws/lambda/" + fnName);
        values.put("getLogStreamName", "playground");
        values.put("getInvokedFunctionArn", "arn:aws:lambda:" + env("AWS_REGION", "us-east-1")
            + ":000000000000:function:" + fnName);
        return Proxy.newProxyInstance(ctxIface.getClassLoader(), new Class<?>[]{ctxIface},
            (proxy, m, a) -> {
                if (m.getName().equals("getRemainingTimeInMillis")) {
                    return (int) Math.max(0, deadline - System.currentTimeMillis());
                }
                if (m.getName().equals("getLogger")) {
                    return makeLogger(m.getReturnType());
                }
                if (values.containsKey(m.getName())) return values.get(m.getName());
                if (m.getReturnType().isPrimitive()) return 0;
                return null;
            });
    }

    static Object makeLogger(Class<?> loggerIface) {
        if (!loggerIface.isInterface()) return null;
        return Proxy.newProxyInstance(loggerIface.getClassLoader(), new Class<?>[]{loggerIface},
            (proxy, m, a) -> {
                if (m.getName().equals("log") && a != null && a.length >= 1) {
                    if (a[0] instanceof byte[]) System.out.println(new String((byte[]) a[0], StandardCharsets.UTF_8));
                    else System.out.println(a[0]);
                }
                return null;
            });
    }

    static Map<String, Object> envelope(boolean ok, String phase, Object response,
                                        Map<String, Object> error, double durationMs) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("ok", ok);
        env.put("phase", phase);
        if (response != null) env.put("response", response);
        if (error != null) env.put("error", error);
        env.put("durationMs", durationMs);
        return env;
    }

    static Map<String, Object> error(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("type", t.getClass().getName());
        err.put("message", t.getMessage() == null ? t.toString() : t.getMessage());
        err.put("stackTrace", List.of(sw.toString().split("\n")));
        return err;
    }

    static void writeResult(String path, Map<String, Object> payload) throws Exception {
        Files.write(Paths.get(path), GSON.toJson(payload).getBytes(StandardCharsets.UTF_8));
    }

    static Map<String, String> parseArgs(String[] argv) {
        Map<String, String> out = new HashMap<>();
        for (int i = 0; i + 1 < argv.length; i += 2) out.put(argv[i], argv[i + 1]);
        return out;
    }

    static String env(String key, String fallback) {
        String v = System.getenv(key);
        return v == null ? fallback : v;
    }
}
```

- [ ] **Step 2: Write the harness build script and build harness.jar**

`harnesses/java/build.sh`:

```bash
#!/usr/bin/env bash
# Builds harness.jar with Gson shaded in. Requires JDK 11+ and network
# (first run only, to download Gson from Maven Central). The resulting
# harness.jar is committed so users and CI never need this script.
set -euo pipefail
cd "$(dirname "$0")"
GSON_VERSION=2.11.0
[ -f gson.jar ] || curl -fsSL -o gson.jar \
  "https://repo1.maven.org/maven2/com/google/code/gson/gson/${GSON_VERSION}/gson-${GSON_VERSION}.jar"
rm -rf build && mkdir -p build/classes
javac --release 11 -cp gson.jar -d build/classes Harness.java
(cd build/classes && jar xf ../../gson.jar com)
jar cf harness.jar -C build/classes .
rm -rf build
echo "Built harnesses/java/harness.jar"
```

Run: `chmod +x harnesses/java/build.sh && harnesses/java/build.sh`
Expected: `Built harnesses/java/harness.jar` (skip this task's remaining steps and leave it unchecked if no JDK is installed — note it in the task report).

- [ ] **Step 3: Write the Java fixture and build it**

`fixtures/java-hello/src/example/Hello.java`:

```java
package example;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import java.util.LinkedHashMap;
import java.util.Map;

public class Hello implements RequestHandler<Map<String, Object>, Map<String, Object>> {
    @Override
    public Map<String, Object> handleRequest(Map<String, Object> event, Context context) {
        context.getLogger().log("hello from java logger");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("message", "hello from java");
        out.put("echo", event);
        out.put("requestId", context.getAwsRequestId());
        return out;
    }
}
```

`fixtures/java-hello/build.sh`:

```bash
#!/usr/bin/env bash
# Builds the java-hello fixture as a fat jar (aws-lambda-java-core shaded
# in, as real Lambda deployment jars are). target/java-hello.jar is
# committed so tests never need this script.
set -euo pipefail
cd "$(dirname "$0")"
CORE_VERSION=1.2.3
[ -f lambda-core.jar ] || curl -fsSL -o lambda-core.jar \
  "https://repo1.maven.org/maven2/com/amazonaws/aws-lambda-java-core/${CORE_VERSION}/aws-lambda-java-core-${CORE_VERSION}.jar"
rm -rf build target && mkdir -p build/classes target
javac --release 11 -cp lambda-core.jar -d build/classes src/example/Hello.java
(cd build/classes && jar xf ../../lambda-core.jar com)
jar cf target/java-hello.jar -C build/classes .
rm -rf build
echo "Built fixtures/java-hello/target/java-hello.jar"
```

Run: `chmod +x fixtures/java-hello/build.sh && fixtures/java-hello/build.sh`
Expected: `Built fixtures/java-hello/target/java-hello.jar`

- [ ] **Step 4: Write the failing test**

`tests/java.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { invoke } = require('../server/invoker');
const { hasRuntime } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'java-hello');
const JAR = path.join(FIXTURE, 'target', 'java-hello.jar');
const skip = !hasRuntime('java', ['-version']) || !fs.existsSync(JAR);

function base(extra = {}) {
  return {
    name: 'java-fn', dir: FIXTURE, runtime: 'java', jarPath: JAR,
    handler: 'example.Hello::handleRequest', event: { j: 1 }, ...extra,
  };
}

test('java RequestHandler happy path with proxied context + logger', { skip }, async () => {
  const r = await invoke(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
  assert.deepStrictEqual(r.response.echo, { j: 1 });
  assert.strictEqual(r.response.requestId, r.report.requestId);
  assert.ok(r.logs.includes('hello from java logger'));
});

test('class-only handler defaults to handleRequest', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Hello' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.response.message, 'hello from java');
});

test('unknown class -> phase:init', { skip }, async () => {
  const r = await invoke(base({ handler: 'example.Nope::handleRequest' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'init');
  assert.strictEqual(r.error.type, 'java.lang.ClassNotFoundException');
});
```

- [ ] **Step 5: Run test to verify it fails, then verify it passes**

Run: `node --test tests/java.test.js`
Expected: before harness.jar exists → FAIL/SKIP; after Steps 2–3 → PASS (3 tests, ~1s JVM startup each; SKIP is acceptable only when java or the fixture jar is genuinely absent)

- [ ] **Step 6: Commit (including the built jars)**

```bash
git add -f harnesses/java/Harness.java harnesses/java/build.sh harnesses/java/harness.jar \
  fixtures/java-hello/src fixtures/java-hello/build.sh fixtures/java-hello/target/java-hello.jar \
  tests/java.test.js
git commit -m "feat: java harness (reflection + gson) and java fixture"
```

---

### Task 8: CLI entry point

**Files:**
- Create: `bin/cli.js`
- Test: `tests/cli.test.js`

**Interfaces:**
- Consumes: `createApp` from `server/index.js`.
- Produces: executable `bin/cli.js` — flags `--port <n>` (default 4590), `--no-open`, `--help`. Prints `aws-playground listening at http://localhost:<actualPort>` (actual bound port, so `--port 0` works). Opens the browser via `open` (darwin) / `cmd /c start` (win32) / `xdg-open` (linux) unless `--no-open`. Exits 1 with a friendly message on `EADDRINUSE`.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('cli starts server, prints URL, serves health, and shuts down', async () => {
  const child = spawn(process.execPath, [CLI, '--port', '0', '--no-open'], {
    env: { ...process.env,
      AWS_PLAYGROUND_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-cli-')) },
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('no URL printed. output: ' + out)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening at (http:\/\/localhost:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  const res = await fetch(url + '/api/health');
  assert.strictEqual(res.status, 200);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));
});

test('cli --help prints usage and exits 0', async () => {
  const child = spawn(process.execPath, [CLI, '--help']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0);
  assert.ok(out.includes('--port'));
  assert.ok(out.includes('--no-open'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.js`
Expected: FAIL (cli.js missing → spawn error / no URL printed)

- [ ] **Step 3: Write the implementation**

`bin/cli.js`:

```js
#!/usr/bin/env node
const { spawn } = require('child_process');
const { createApp } = require('../server');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (flag('--help') || flag('-h')) {
  console.log(`Usage: aws-playground [--port <n>] [--no-open]

Starts the Lambda Playground server and opens it in your browser.

  --port <n>   Port to listen on (default 4590)
  --no-open    Do not open the browser automatically`);
  process.exit(0);
}

const port = parseInt(optValue('--port', '4590'), 10);
const app = createApp();
const server = app.listen(port, () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`aws-playground listening at ${url}`);
  if (!flag('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    spawn(opener, openArgs, { stdio: 'ignore', detached: true }).unref();
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: aws-playground --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
});
```

Run: `chmod +x bin/cli.js`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js tests/cli.test.js
git commit -m "feat: aws-playground CLI entry point"
```

---

### Task 9: Frontend UI

**Files:**
- Create: `public/vendor/codemirror/*` (vendored), `public/styles.css`, `public/app.js`
- Modify: `public/index.html` (replace the Task 6 placeholder entirely)
- Test: `tests/frontend.test.js`

**Interfaces:**
- Consumes: every `/api/*` route from Task 6, response/report shapes from Task 5.
- Produces: the complete single-page UI. No build step; `app.js` is a plain browser script using the `CodeMirror` global.

- [ ] **Step 1: Vendor CodeMirror**

```bash
mkdir -p public/vendor/codemirror
BASE=https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16
curl -fsSL -o public/vendor/codemirror/codemirror.min.css "$BASE/codemirror.min.css"
curl -fsSL -o public/vendor/codemirror/codemirror.min.js "$BASE/codemirror.min.js"
curl -fsSL -o public/vendor/codemirror/javascript.min.js "$BASE/mode/javascript/javascript.min.js"
curl -fsSL -o public/vendor/codemirror/material-darker.min.css "$BASE/theme/material-darker.min.css"
```

(If 5.65.16 404s, use the latest 5.65.x listed at cdnjs.com/libraries/codemirror.)

- [ ] **Step 2: Write the failing smoke test**

`tests/frontend.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-fe-'));
const { createApp } = require('../server/index');

let server, baseUrl;
before(() => new Promise((resolve) => {
  server = createApp().listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

test('index.html references the app assets', async () => {
  const html = await (await fetch(baseUrl + '/')).text();
  assert.ok(html.includes('Lambda Playground'));
  assert.ok(html.includes('app.js'));
  assert.ok(html.includes('styles.css'));
  assert.ok(html.includes('vendor/codemirror/codemirror.min.js'));
});

test('static assets are served', async () => {
  for (const asset of ['/app.js', '/styles.css', '/vendor/codemirror/codemirror.min.js']) {
    const res = await fetch(baseUrl + asset);
    assert.strictEqual(res.status, 200, asset);
  }
});

test('app.js parses as valid javascript', () => {
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'public', 'app.js')]);
});
```

Run: `node --test tests/frontend.test.js`
Expected: FAIL (placeholder index.html lacks app.js reference; /app.js 404)

- [ ] **Step 3: Write index.html (full replacement of the placeholder)**

`public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lambda Playground</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="vendor/codemirror/codemirror.min.css">
  <link rel="stylesheet" href="vendor/codemirror/material-darker.min.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <h1>&lambda; Lambda Playground</h1>
    <div id="health-strip"></div>
  </header>
  <div class="layout">
    <aside id="sidebar">
      <div class="sidebar-head">
        <span>Functions</span>
        <button id="add-btn" class="ghost">+ Add</button>
      </div>
      <form id="add-form" class="hidden">
        <input id="add-path" placeholder="/absolute/path/to/project" spellcheck="false" autocomplete="off">
        <div id="add-suggestions"></div>
        <input id="add-name" placeholder="Function name" autocomplete="off">
        <select id="add-runtime">
          <option value="python">python</option>
          <option value="node">node</option>
          <option value="java">java</option>
        </select>
        <input id="add-handler" placeholder="Handler, e.g. app.handler" spellcheck="false" autocomplete="off">
        <div class="row">
          <button type="submit">Register</button>
          <button type="button" id="add-cancel" class="ghost">Cancel</button>
        </div>
        <div id="add-error" class="error-text"></div>
      </form>
      <ul id="fn-list"></ul>
    </aside>
    <main id="main">
      <div id="empty-state">Register a function to get started.</div>
      <div id="fn-view" class="hidden">
        <div class="config-row">
          <span id="runtime-badge" class="badge"></span>
          <label>Handler <input id="cfg-handler" spellcheck="false"></label>
          <label>Timeout (ms) <input id="cfg-timeout" type="number" min="100" step="1000"></label>
          <label>Memory (MB) <input id="cfg-memory" type="number" min="128" step="64"></label>
          <label id="cfg-jar-label" class="hidden">Jar path <input id="cfg-jar" spellcheck="false"></label>
          <button id="delete-btn" class="ghost danger">Delete</button>
        </div>
        <details open class="env-box">
          <summary>Environment variables</summary>
          <div id="env-rows"></div>
          <button id="env-add" class="ghost">+ Add variable</button>
        </details>
        <div class="event-head">
          <select id="tpl-select"><option value="">Event template&hellip;</option></select>
          <select id="saved-select"><option value="">Saved events&hellip;</option></select>
          <button id="save-event" class="ghost">Save event</button>
          <span class="spacer"></span>
          <button id="invoke-btn">Invoke &#9654;</button>
        </div>
        <textarea id="event-editor">{}</textarea>
        <div class="tabs">
          <button data-tab="response" class="tab active">Response</button>
          <button data-tab="logs" class="tab">Logs</button>
          <button data-tab="report" class="tab">Report</button>
        </div>
        <pre id="pane-response" class="pane">Invoke to see the response.</pre>
        <pre id="pane-logs" class="pane hidden"></pre>
        <pre id="pane-report" class="pane hidden"></pre>
        <div class="history-head">History (this session)</div>
        <ul id="history"></ul>
      </div>
    </main>
  </div>
  <script src="vendor/codemirror/codemirror.min.js"></script>
  <script src="vendor/codemirror/javascript.min.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write styles.css**

`public/styles.css`:

```css
:root {
  --bg: #0d1117;
  --bg-raised: #161b22;
  --bg-inset: #010409;
  --border: #30363d;
  --text: #e6edf3;
  --text-dim: #8b949e;
  --accent: #f5a623;
  --ok: #3fb950;
  --err: #f85149;
  --font-sans: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-sans); font-size: 14px; height: 100vh;
  display: flex; flex-direction: column;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}
header h1 { font-size: 15px; margin: 0; color: var(--accent); font-weight: 600; }
#health-strip { display: flex; gap: 8px; font-family: var(--font-mono); font-size: 11px; }
.chip { padding: 2px 8px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-dim); }
.chip.ok { color: var(--ok); border-color: var(--ok); }
.chip.missing { color: var(--err); border-color: var(--err); }
.layout { display: flex; flex: 1; min-height: 0; }
#sidebar {
  width: 260px; border-right: 1px solid var(--border); background: var(--bg-raised);
  overflow-y: auto; padding: 12px; flex-shrink: 0;
}
.sidebar-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-weight: 600; }
#fn-list { list-style: none; margin: 0; padding: 0; }
#fn-list li {
  padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
  display: flex; align-items: center; gap: 8px;
}
#fn-list li:hover { background: var(--bg); }
#fn-list li.active { background: var(--bg); outline: 1px solid var(--accent); }
.badge {
  font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
  padding: 2px 6px; border-radius: 4px; background: var(--bg-inset);
  border: 1px solid var(--border); color: var(--accent);
}
#add-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
#add-form .row { display: flex; gap: 8px; }
#add-suggestions { display: flex; flex-wrap: wrap; gap: 4px; }
#add-suggestions button { font-size: 11px; }
.error-text { color: var(--err); font-size: 12px; min-height: 1em; }
#main { flex: 1; overflow-y: auto; padding: 16px 20px; min-width: 0; }
#empty-state { color: var(--text-dim); margin-top: 40px; text-align: center; }
.config-row { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
.config-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.env-box { margin-bottom: 12px; }
.env-box summary { cursor: pointer; color: var(--text-dim); margin-bottom: 6px; }
.env-row { display: flex; gap: 6px; margin-bottom: 6px; }
.env-row input { flex: 1; font-family: var(--font-mono); }
.event-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.event-head .spacer { flex: 1; }
input, select, button, textarea {
  background: var(--bg-inset); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px; font-family: inherit; font-size: 13px;
}
input:focus, select:focus { outline: 1px solid var(--accent); }
button { cursor: pointer; background: var(--accent); color: #10120a; font-weight: 600; border: none; }
button:disabled { opacity: 0.5; cursor: wait; }
button.ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); font-weight: 400; }
button.ghost:hover { color: var(--text); }
button.danger { color: var(--err); border-color: var(--err); }
.CodeMirror {
  height: 180px; border: 1px solid var(--border); border-radius: 6px;
  font-family: var(--font-mono); font-size: 13px; margin-bottom: 12px;
}
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
.tab { background: transparent; color: var(--text-dim); border: none; padding: 8px 14px; border-radius: 6px 6px 0 0; }
.tab.active { color: var(--accent); background: var(--bg-raised); }
.pane {
  background: var(--bg-inset); border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 6px 6px; padding: 12px; margin: 0 0 14px;
  font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap;
  word-break: break-word; min-height: 120px; max-height: 320px; overflow-y: auto;
}
.pane.ok { border-left: 3px solid var(--ok); }
.pane.err { border-left: 3px solid var(--err); color: var(--err); }
.history-head { color: var(--text-dim); font-size: 12px; margin-bottom: 6px; }
#history { list-style: none; margin: 0; padding: 0; font-family: var(--font-mono); font-size: 12px; }
#history li {
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px;
  margin-bottom: 4px; cursor: pointer; display: flex; gap: 10px;
}
#history li:hover { border-color: var(--accent); }
#history .h-ok { color: var(--ok); }
#history .h-err { color: var(--err); }
.hidden { display: none !important; }
```

- [ ] **Step 5: Write app.js**

`public/app.js`:

```js
/* global CodeMirror */
'use strict';

const api = {
  async health() { return (await fetch('/api/health')).json(); },
  async list() { return (await fetch('/api/functions')).json(); },
  async create(body) {
    const r = await fetch('/api/functions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  },
  async update(id, patch) {
    const r = await fetch(`/api/functions/${id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    return r.json();
  },
  async remove(id) { await fetch(`/api/functions/${id}`, { method: 'DELETE' }); },
  async detect(dir) {
    const r = await fetch('/api/detect', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
    return r.json();
  },
  async invoke(body) {
    const r = await fetch('/api/invoke', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  },
};

const EVENT_TEMPLATES = {
  'Empty': {},
  'API Gateway proxy': {
    resource: '/{proxy+}', path: '/hello', httpMethod: 'GET',
    headers: { Accept: '*/*' }, queryStringParameters: { name: 'world' },
    pathParameters: { proxy: 'hello' }, body: null, isBase64Encoded: false,
  },
  'S3 put': { Records: [{ eventVersion: '2.1', eventSource: 'aws:s3',
    awsRegion: 'us-east-1', eventName: 'ObjectCreated:Put',
    s3: { bucket: { name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket' },
      object: { key: 'test/key.txt', size: 1024 } } }] },
  'SQS message': { Records: [{ messageId: '19dd0b57-b21e-4ac1-bd88-01bbb068cb78',
    receiptHandle: 'MessageReceiptHandle', body: 'Hello from SQS!',
    attributes: { ApproximateReceiveCount: '1' }, eventSource: 'aws:sqs',
    awsRegion: 'us-east-1' }] },
  'EventBridge': { version: '0', id: 'fdd6cb98-d2e2-4ecf-a6f6-1d8b0f4e327a',
    'detail-type': 'Scheduled Event', source: 'aws.events',
    time: '2026-01-01T00:00:00Z', region: 'us-east-1', detail: {} },
  'DynamoDB stream': { Records: [{ eventID: '1', eventName: 'INSERT',
    eventSource: 'aws:dynamodb', awsRegion: 'us-east-1',
    dynamodb: { Keys: { Id: { N: '101' } },
      NewImage: { Id: { N: '101' }, Message: { S: 'hello' } },
      StreamViewType: 'NEW_AND_OLD_IMAGES' } }] },
};

const state = { functions: [], selectedId: null, history: [], health: null };
const $ = (id) => document.getElementById(id);
let editor;

function selected() { return state.functions.find(f => f.id === state.selectedId) || null; }

async function refresh() {
  state.functions = (await api.list()).functions;
  if (!selected()) state.selectedId = state.functions[0]?.id || null;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const ul = $('fn-list');
  ul.innerHTML = '';
  for (const fn of state.functions) {
    const li = document.createElement('li');
    if (fn.id === state.selectedId) li.className = 'active';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = fn.runtime;
    li.appendChild(badge);
    li.appendChild(document.createTextNode(fn.name));
    if (state.health && state.health[fn.runtime] && !state.health[fn.runtime].available) {
      const warn = document.createElement('span');
      warn.textContent = '⚠';
      warn.title = `${fn.runtime} runtime not found on this machine`;
      li.appendChild(warn);
    }
    li.onclick = () => {
      state.selectedId = fn.id;
      state.history = [];
      renderSidebar();
      renderMain();
    };
    ul.appendChild(li);
  }
}

function renderMain() {
  const fn = selected();
  $('empty-state').classList.toggle('hidden', !!fn);
  $('fn-view').classList.toggle('hidden', !fn);
  if (!fn) return;
  $('runtime-badge').textContent = fn.runtime;
  $('cfg-handler').value = fn.handler;
  $('cfg-timeout').value = fn.timeoutMs;
  $('cfg-memory').value = fn.memoryMb;
  $('cfg-jar').value = fn.jarPath || '';
  $('cfg-jar-label').classList.toggle('hidden', fn.runtime !== 'java');
  renderEnvRows(fn.env);
  renderSavedSelect();
  renderHistory();
}

function envRow(k, v) {
  const row = document.createElement('div');
  row.className = 'env-row';
  const key = document.createElement('input');
  key.className = 'env-k'; key.placeholder = 'KEY'; key.value = k;
  const val = document.createElement('input');
  val.className = 'env-v'; val.placeholder = 'value'; val.value = v;
  const del = document.createElement('button');
  del.className = 'ghost env-del'; del.type = 'button'; del.textContent = '✕';
  del.onclick = () => { row.remove(); saveEnv(); };
  key.onchange = saveEnv; val.onchange = saveEnv;
  row.append(key, val, del);
  return row;
}

function renderEnvRows(env) {
  const box = $('env-rows');
  box.innerHTML = '';
  for (const [k, v] of Object.entries(env || {})) box.appendChild(envRow(k, v));
}

function collectEnv() {
  const env = {};
  for (const row of document.querySelectorAll('#env-rows .env-row')) {
    const k = row.querySelector('.env-k').value.trim();
    if (k) env[k] = row.querySelector('.env-v').value;
  }
  return env;
}

async function saveEnv() {
  const fn = selected();
  if (!fn) return;
  fn.env = collectEnv();
  await api.update(fn.id, { env: fn.env });
}

function renderSavedSelect() {
  const fn = selected();
  const sel = $('saved-select');
  sel.innerHTML = '<option value="">Saved events&hellip;</option>';
  for (const ev of fn?.savedEvents || []) {
    const opt = document.createElement('option');
    opt.value = ev.name;
    opt.textContent = ev.name;
    sel.appendChild(opt);
  }
}

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  for (const h of state.history) {
    const li = document.createElement('li');
    const status = document.createElement('span');
    status.className = h.result.ok ? 'h-ok' : 'h-err';
    status.textContent = h.result.ok ? 'OK' : (h.result.error?.type || 'Error');
    const time = document.createElement('span');
    time.textContent = h.at;
    const dur = document.createElement('span');
    dur.textContent = h.result.report ? `${h.result.report.durationMs} ms` : '';
    li.append(time, status, dur);
    li.onclick = () => showResult(h.result);
    ul.appendChild(li);
  }
}

function setTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.tab === name);
  }
  for (const p of ['response', 'logs', 'report']) {
    $(`pane-${p}`).classList.toggle('hidden', p !== name);
  }
}

function showResult(r) {
  const resp = $('pane-response');
  if (r.ok) {
    resp.className = 'pane ok';
    resp.textContent = JSON.stringify(r.response, null, 2);
  } else {
    resp.className = 'pane err';
    const initNote = r.phase === 'init'
      ? '— function failed before the handler ran (init phase)\n\n' : '';
    resp.textContent = initNote + JSON.stringify({
      errorType: r.error.type,
      errorMessage: r.error.message,
      stackTrace: r.error.stackTrace,
    }, null, 2);
  }
  $('pane-logs').textContent = r.logs || '(no log output)';
  $('pane-report').textContent = r.report ? [
    `REPORT RequestId: ${r.report.requestId}`,
    `Duration: ${r.report.durationMs} ms`,
    `Billed Duration: ${r.report.billedMs} ms`,
    `Memory Size: ${r.report.memoryMb} MB`,
    `Status: ${r.report.timedOut ? 'Timeout' : r.ok ? 'OK' : 'Error'}`,
  ].join('\t') : '(no report)';
  setTab('response');
}

async function doInvoke() {
  const fn = selected();
  if (!fn) return;
  let event;
  try {
    event = JSON.parse(editor.getValue());
  } catch (e) {
    showResult({ ok: false, phase: 'invoke', logs: '', report: null,
      error: { type: 'InvalidEventJson', message: e.message, stackTrace: [] } });
    return;
  }
  const btn = $('invoke-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const result = await api.invoke({
      functionId: fn.id,
      handler: $('cfg-handler').value,
      event,
      envVars: collectEnv(),
      timeoutMs: parseInt($('cfg-timeout').value, 10) || 30000,
      memoryMb: parseInt($('cfg-memory').value, 10) || 128,
    });
    state.history.unshift({ at: new Date().toLocaleTimeString(), result });
    renderHistory();
    showResult(result);
  } catch (e) {
    showResult({ ok: false, phase: 'invoke', logs: '', report: null,
      error: { type: 'RequestFailed', message: e.message, stackTrace: [] } });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Invoke ▶';
  }
}

async function renderHealth() {
  const { runtimes } = await api.health();
  state.health = runtimes;
  renderSidebar();
  const strip = $('health-strip');
  strip.innerHTML = '';
  for (const [name, info] of Object.entries(runtimes)) {
    const chip = document.createElement('span');
    chip.className = `chip ${info.available ? 'ok' : 'missing'}`;
    chip.textContent = info.available ? `${name} ${info.version}` : `${name} ✕`;
    chip.title = info.available ? '' : `${name} runtime not found on this machine`;
    strip.appendChild(chip);
  }
}

function bindConfig() {
  const save = async (patch) => {
    const fn = selected();
    if (fn) Object.assign(fn, await api.update(fn.id, patch));
  };
  $('cfg-handler').onchange = () => save({ handler: $('cfg-handler').value });
  $('cfg-timeout').onchange = () => save({ timeoutMs: parseInt($('cfg-timeout').value, 10) || 30000 });
  $('cfg-memory').onchange = () => save({ memoryMb: parseInt($('cfg-memory').value, 10) || 128 });
  $('cfg-jar').onchange = () => save({ jarPath: $('cfg-jar').value || null });
  $('delete-btn').onclick = async () => {
    const fn = selected();
    if (fn && confirm(`Remove '${fn.name}' from the playground? (Your code is untouched.)`)) {
      await api.remove(fn.id);
      state.selectedId = null;
      refresh();
    }
  };
}

function bindAddForm() {
  $('add-btn').onclick = () => $('add-form').classList.toggle('hidden');
  $('add-cancel').onclick = () => $('add-form').classList.add('hidden');
  $('add-path').onblur = async () => {
    const dir = $('add-path').value.trim();
    if (!dir) return;
    const d = await api.detect(dir);
    $('add-error').textContent = d.error ? `Not a directory: ${dir}` : '';
    if (d.error) return;
    if (d.runtime) $('add-runtime').value = d.runtime;
    if (!$('add-name').value) $('add-name').value = dir.split('/').filter(Boolean).pop();
    const box = $('add-suggestions');
    box.innerHTML = '';
    for (const cand of d.handlerCandidates.slice(0, 6)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = cand;
      b.onclick = () => { $('add-handler').value = cand; };
      box.appendChild(b);
    }
    if (d.handlerCandidates.length === 1) $('add-handler').value = d.handlerCandidates[0];
  };
  $('add-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const fn = await api.create({
        name: $('add-name').value.trim(),
        path: $('add-path').value.trim(),
        runtime: $('add-runtime').value,
        handler: $('add-handler').value.trim(),
      });
      $('add-form').classList.add('hidden');
      $('add-form').reset();
      $('add-suggestions').innerHTML = '';
      state.selectedId = fn.id;
      refresh();
    } catch (err) {
      $('add-error').textContent = err.message;
    }
  };
}

function bindEvents() {
  const tpl = $('tpl-select');
  for (const name of Object.keys(EVENT_TEMPLATES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    tpl.appendChild(opt);
  }
  tpl.onchange = () => {
    const t = EVENT_TEMPLATES[tpl.value];
    if (t) editor.setValue(JSON.stringify(t, null, 2));
  };
  $('saved-select').onchange = () => {
    const fn = selected();
    const ev = fn?.savedEvents.find(x => x.name === $('saved-select').value);
    if (ev) editor.setValue(ev.json);
  };
  $('save-event').onclick = async () => {
    const fn = selected();
    if (!fn) return;
    const name = prompt('Save event as:');
    if (!name) return;
    const events = fn.savedEvents.filter(x => x.name !== name);
    events.push({ name, json: editor.getValue() });
    Object.assign(fn, await api.update(fn.id, { savedEvents: events }));
    renderSavedSelect();
  };
  $('env-add').onclick = () => $('env-rows').appendChild(envRow('', ''));
  $('invoke-btn').onclick = doInvoke;
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => setTab(t.dataset.tab);
  }
}

function init() {
  editor = CodeMirror.fromTextArea($('event-editor'), {
    mode: { name: 'javascript', json: true },
    theme: 'material-darker',
    lineNumbers: true,
  });
  bindConfig();
  bindAddForm();
  bindEvents();
  renderHealth();
  refresh();
}

init();
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/frontend.test.js`
Expected: PASS (3 tests)

- [ ] **Step 7: Manual smoke check**

Run: `node bin/cli.js --no-open`, open http://localhost:4590 in a browser. Verify: health chips render; register `fixtures/python-hello` (path suggestion fills handler `app.handler`); pick the "S3 put" template; Invoke shows response JSON, logs contain `hello log line`, report shows a REPORT line; an env var added in the UI survives a page reload. Stop the server (Ctrl-C).

- [ ] **Step 8: Commit**

```bash
git add public tests/frontend.test.js
git commit -m "feat: frontend UI with event editor, env vars, and result tabs"
```

---

### Task 10: README + full verification

**Files:**
- Create: `README.md`
- Modify: none

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write README.md**

```markdown
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
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (python/java tests may SKIP only when those runtimes are absent)

- [ ] **Step 3: End-to-end CLI verification**

```bash
npm install -g .
aws-playground --port 4591 --no-open &
sleep 1
curl -s http://localhost:4591/api/health
kill %1
npm uninstall -g aws-playground
```

Expected: health JSON printed with runtime availability.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with install, runtimes, and AWS-services guidance"
```
