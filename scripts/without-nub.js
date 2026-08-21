#!/usr/bin/env node
// Runs a command with nub's runtime injection stripped from the environment.
//
// nub (nubjs.com) augments every child `node` two ways: a temporary node-shim
// directory prepended to PATH, and a --require'd preload in NODE_OPTIONS. The
// preload breaks `node --test` child processes: on Node 22 each test file
// exits 0 having run zero tests, so `nub run test` reports green without
// testing anything. Test scripts go through this wrapper so the suite is
// honest no matter which package manager invoked it. Under plain npm the
// environment has none of these markers and this is a pass-through.
const { spawnSync } = require('child_process');
const { delimiter } = require('path');

function withoutNub(env) {
  const cleaned = { ...env };
  if (cleaned.PATH) {
    cleaned.PATH = cleaned.PATH.split(delimiter)
      .filter((dir) => !dir.includes('nub-node-shim'))
      .join(delimiter);
  }
  if (cleaned.NODE_OPTIONS) {
    const kept = cleaned.NODE_OPTIONS.split(/\s+/)
      .filter((opt) => opt && !/nub[/\\]runtime-/.test(opt));
    if (kept.length) cleaned.NODE_OPTIONS = kept.join(' ');
    else delete cleaned.NODE_OPTIONS;
  }
  return cleaned;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: without-nub.js <command> [args...]');
    process.exit(2);
  }
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: withoutNub(process.env),
    shell: process.platform === 'win32',
  });
  process.exit(res.status === null ? 1 : res.status);
}

if (require.main === module) main();

module.exports = { withoutNub };
