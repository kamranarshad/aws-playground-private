const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeRequest, splitAtSentinel } = require('./protocol');

// Live handler processes, reused across invokes the way real Lambda reuses an
// execution environment. Everything that would change how a handler behaves is
// in the key, so a change means a new environment rather than a stale one.
//
// This is an explicit object rather than ambient module state so that callers
// -- tests especially -- opt into warm behaviour deliberately instead of
// discovering it by accident.
const DEFAULT_IDLE_MS = 300000;

// Written by a runtime rather than by the user, so a change here is not a
// source change. Skipping them also keeps the fingerprint walk cheap.
const DERIVED = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', 'target']);

// Bounded so a pathologically large project cannot make every invoke slow.
const MAX_FINGERPRINT_FILES = 5000;

// A cheap content fingerprint of the user's source: path, size and mtime of
// every non-derived file.
//
// This replaced an fs.watch approach that could not work. Importing a handler
// makes the runtime touch its own source -- python's import machinery emits a
// rename event for the very file it is reading -- so a watcher fires on the
// act of starting the handler and cannot tell that apart from a real edit.
// Comparing content is unambiguous, deterministic and platform-independent.
function fingerprint(dir) {
  const parts = [];
  let count = 0;
  const walk = (d, rel) => {
    if (count >= MAX_FINGERPRINT_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (DERIVED.has(e.name) || e.name.startsWith('.')) continue;
      const child = path.join(d, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(child, childRel); continue; }
      if (!e.isFile()) continue;
      if (++count > MAX_FINGERPRINT_FILES) return;
      try {
        const st = fs.statSync(child);
        parts.push(`${childRel}:${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  };
  walk(dir, '');
  return crypto.createHash('sha1').update(parts.sort().join('\n')).digest('hex');
}

function idleMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_WARM_IDLE_MS, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_MS;
}

// timeoutMs is deliberately absent: the parent enforces it per invoke, so
// changing it does not require a different process.
function keyFor(opts) {
  const env = Object.entries(opts.env ?? {})
    // Excluded because it *is* the key: the invoker stamps the environment's
    // own id in here after hashing, so including it would be circular.
    .filter(([k]) => k !== 'OTEL_RESOURCE_ATTRIBUTES')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([
    opts.id, opts.runtime, opts.dir, opts.handler,
    opts.memoryMb, opts.jarPath ?? null, opts.autoTrace === true, env,
  ])).digest('hex');
}

/** key -> Env */
const envs = new Map();

function size() {
  return envs.size;
}

class Env {
  constructor(key, opts, sourceFingerprint) {
    this.key = key;
    this.functionId = opts.id;
    this.dir = opts.dir;
    this.memoryMb = opts.memoryMb;
    this.cold = true;
    this.busy = false;
    this.dead = false;
    this.buf = '';
    this.pending = null;
    this.idleTimer = null;
    this.sourceFingerprint = sourceFingerprint ?? fingerprint(opts.dir);

    this.child = spawn(opts.command.cmd, opts.command.args, {
      cwd: opts.dir,
      env: opts.env,
      detached: process.platform !== 'win32',
    });
    const onOutput = (d) => {
      this.buf += d;
      this.tryResolve();
    };
    this.child.stdout.on('data', onOutput);
    this.child.stderr.on('data', onOutput);
    this.child.stdin.on('error', () => {});
    // An idle environment must not hold the event loop open -- otherwise any
    // process that has ever invoked a function refuses to exit. The refs go
    // back on for the duration of a send, so an in-flight invoke still keeps
    // the process alive long enough to finish.
    this.unrefIdle();
    this.child.on('error', (err) => this.die(Object.assign(err, { spawnFailed: true })));
    this.child.on('close', (code) => this.die(Object.assign(
      new Error(`the handler process exited (code ${code})`), { exitCode: code })));

  }

  tryResolve() {
    if (!this.pending) return;
    const split = splitAtSentinel(this.buf, this.pending.requestId);
    if (!split) return;
    this.buf = split.rest;
    const { resolve, resultFile } = this.pending;
    let envelope = null;
    try { envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
    try { fs.unlinkSync(resultFile); } catch {}
    this.settle();
    resolve({ logs: split.logs, envelope });
  }

  settle() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.busy = false;
  }

  die(err) {
    if (this.dead) return;
    this.dead = true;
    const pending = this.pending;
    // Whatever the handler printed before taking the process down is the only
    // evidence of why it died, so it has to survive the rejection.
    if (pending) err.logs = this.buf;
    this.settle();
    envs.delete(this.key);
    this.teardown();
    if (pending) pending.reject(err);
  }

  teardown() {
    clearTimeout(this.idleTimer);
    try {
      if (this.child.pid) {
        if (process.platform === 'win32') this.child.kill('SIGKILL');
        else process.kill(-this.child.pid, 'SIGKILL');
      }
    } catch {}
  }

  // stdio are net.Sockets at runtime and do have ref/unref, but the stream
  // types they are declared as do not.
  unrefIdle() {
    this.child.unref();
    for (const s of [this.child.stdout, this.child.stderr, this.child.stdin]) {
      /** @type {any} */ (s)?.unref?.();
    }
  }

  refBusy() {
    this.child.ref();
    for (const s of [this.child.stdout, this.child.stderr, this.child.stdin]) {
      /** @type {any} */ (s)?.ref?.();
    }
  }

  hasExited() {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => evict(this.key), idleMs());
    this.idleTimer.unref?.();
  }

  // requestId comes from the caller: the handler sees it as its Context's
  // awsRequestId, and the invoker reports the same value and correlates
  // history and spans by it, so minting a second one here would make the id
  // the handler sees disagree with the id everything else uses.
  send({ event, timeoutMs, requestId = crypto.randomUUID() }) {
    // The log sentinel cannot disambiguate interleaved output, so this asserts
    // the one-invoke-per-function guard rather than trusting it.
    if (this.busy) return Promise.reject(new Error('this environment is already serving an invoke'));
    if (this.dead) return Promise.reject(new Error('the handler process is no longer running'));
    this.busy = true;
    this.refBusy();
    clearTimeout(this.idleTimer);

    const resultFile = path.join(os.tmpdir(), `awsplay-${requestId}.json`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out environment is destroyed, matching Lambda.
        this.die(Object.assign(new Error('the invoke timed out'), { timedOut: true }));
      }, timeoutMs);
      timer.unref?.();
      this.pending = { requestId, resultFile, resolve, reject, timer };
      try {
        this.child.stdin.write(encodeRequest({
          requestId, resultFile, event, timeoutMs, memoryMb: this.memoryMb,
        }));
      } catch (err) {
        this.die(err);
      }
    }).finally(() => {
      if (this.dead) return;
      this.unrefIdle();
      this.touch();
    });
  }
}

async function acquire(opts) {
  const key = keyFor(opts);
  const existing = envs.get(key);
  // `dead` is set from the child's 'close' event, which arrives a tick after
  // the process is actually gone -- so an acquire in that window would hand
  // back an environment that can never answer. Ask the process directly.
  const fp = fingerprint(opts.dir);
  if (existing && !existing.dead && !existing.hasExited()) {
    // The one deliberate break from Lambda: locally the source changes under a
    // warm environment constantly, and serving the previous version would make
    // the tool actively wrong. Checked here rather than watched, because the
    // act of importing a handler touches its own source file.
    if (fp === existing.sourceFingerprint) {
      existing.cold = false;
      return existing;
    }
    evict(key);
  } else if (existing) {
    evict(key);
  }
  const env = new Env(key, opts, fp);
  envs.set(key, env);
  return env;
}

function evict(key) {
  const env = envs.get(key);
  if (!env) return;
  envs.delete(key);
  env.dead = true;
  const pending = env.pending;
  env.settle();
  env.teardown();
  if (pending) pending.reject(new Error('the handler process was evicted'));
}

function evictForFunction(functionId) {
  for (const [key, env] of Array.from(envs)) {
    if (env.functionId === functionId) evict(key);
  }
}

async function shutdown() {
  for (const key of Array.from(envs.keys())) evict(key);
}

module.exports = { keyFor, acquire, evict, evictForFunction, shutdown, size, DEFAULT_IDLE_MS, idleMs };
