#!/usr/bin/env node
// The docker-backed integration tests use fixed container names
// (aws-playground-minio and friends) and fixed ports, so two runs on one
// machine fight over them. That used to surface as a silent hour-long hang.
//
// The lock is held by this runner rather than by individual test files: the
// test runner gives each file its own process, so a per-file check cannot
// tell our own earlier file apart from a competing run.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK = path.join(os.tmpdir(), 'aws-playground-integration.lock');

function holderPid() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (!Number.isInteger(pid)) return null;
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // ENOENT: no lock. ESRCH: the holder died without releasing it.
    return err.code === 'EPERM' ? -1 : null;
  }
}

const held = holderPid();
if (held !== null) {
  console.error(
    `aws-playground: another integration run (pid ${held}) is already holding the\n`
    + 'docker-backed tests. They use fixed container names and ports, so they cannot\n'
    + `run concurrently. Wait for it to finish, or remove ${LOCK} if it is stale.`);
  process.exit(1);
}

fs.writeFileSync(LOCK, String(process.pid));
const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { release(); process.exit(1); });
}

const child = spawn(process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=120000', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: path.join(__dirname, '..') });
child.on('exit', (code, signal) => {
  release();
  process.exit(signal ? 1 : code);
});
