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

function idleMs() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_WARM_IDLE_MS, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_MS;
}

// timeoutMs is deliberately absent: the parent enforces it per invoke, so
// changing it does not require a different process.
function keyFor(opts) {
  const env = Object.entries(opts.env ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
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
  constructor(key, opts) {
    this.key = key;
    this.functionId = opts.id;
    this.dir = opts.dir;
    this.memoryMb = opts.memoryMb;
    this.cold = true;
    this.busy = false;
    this.dead = false;
    this.buf = '';
    this.pending = null;
    this.watcher = null;
    this.idleTimer = null;
    // Without a watch the only safe behaviour is a cold start every invoke:
    // slower, but it can never serve code the user has already changed.
    this.unwatchable = false;

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
    this.child.on('error', (err) => this.die(err));
    this.child.on('close', (code) => this.die(
      new Error(`the handler process exited (code ${code})`)));

    if (opts.watch === false) this.unwatchable = true;
    else this.startWatching();
  }

  // Real Lambda has no notion of the code changing under a warm environment;
  // locally it changes constantly, and serving the previous version would make
  // the tool actively wrong. This is the one deliberate break from Lambda.
  startWatching() {
    try {
      const own = path.basename(this.dir);
      this.watcher = fs.watch(this.dir, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        // macOS emits an extra event naming the watched directory itself for
        // any descendant change. It says nothing about *what* changed, and a
        // real edit always also emits an event naming the actual file, so
        // acting on it would evict on node_modules churn for no reason. Guard
        // against a genuine file that happens to share the directory's name.
        if (name === own && !fs.existsSync(path.join(this.dir, name))) return;
        if (name.includes('node_modules') || path.basename(name).startsWith('.')) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => evict(this.key), 100);
        this.debounce.unref?.();
      });
    } catch (err) {
      this.unwatchable = true;
      console.warn(`aws-playground: cannot watch ${this.dir} for changes (${err.message}); `
        + 'this function will cold start every invoke so it never runs stale code.');
    }
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
    this.settle();
    envs.delete(this.key);
    this.teardown();
    if (pending) pending.reject(err);
  }

  teardown() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.debounce);
    // A leaked recursive watcher is a real descriptor leak.
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    try {
      if (this.child.pid) {
        if (process.platform === 'win32') this.child.kill('SIGKILL');
        else process.kill(-this.child.pid, 'SIGKILL');
      }
    } catch {}
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => evict(this.key), idleMs());
    this.idleTimer.unref?.();
  }

  send({ event, timeoutMs }) {
    // The log sentinel cannot disambiguate interleaved output, so this asserts
    // the one-invoke-per-function guard rather than trusting it.
    if (this.busy) return Promise.reject(new Error('this environment is already serving an invoke'));
    if (this.dead) return Promise.reject(new Error('the handler process is no longer running'));
    this.busy = true;
    clearTimeout(this.idleTimer);

    const requestId = crypto.randomUUID();
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
      // No watch means no way to know the source changed, so never reuse.
      if (this.unwatchable) evict(this.key);
      else this.touch();
    });
  }
}

async function acquire(opts) {
  const key = keyFor(opts);
  const existing = envs.get(key);
  if (existing && !existing.dead) {
    existing.cold = false;
    return existing;
  }
  const env = new Env(key, opts);
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
  for (const [key, env] of [...envs]) {
    if (env.functionId === functionId) evict(key);
  }
}

async function shutdown() {
  for (const key of [...envs.keys()]) evict(key);
}

module.exports = { keyFor, acquire, evict, evictForFunction, shutdown, size, DEFAULT_IDLE_MS, idleMs };
