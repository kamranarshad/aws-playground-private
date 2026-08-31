const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasRuntime(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Scripted "docker" for hermetic service tests: reads scenario.json, prints
// the scripted stdout, exits with the scripted code, and appends its argv to
// calls.log. A single node process on purpose — the previous bash shim ran
// three `node -pe` subshells per call, and under full-suite parallel load one
// of them could fail (fork pressure), turning a scripted success into a
// nonzero exit that services.js reads as "docker unavailable". Lookup is
// "<cmd> <subcmd>" first, then "<cmd>", defaulting to {code:1, stdout:''}.
function writeDockerShim(dir) {
  const shim = path.join(dir, 'docker');
  const scenario = path.join(dir, 'scenario.json');
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(shim, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
function read() {
  return JSON.parse(fs.readFileSync(${JSON.stringify(scenario)}, 'utf8'));
}
let s;
// One retry: writeScenario swaps the file atomically, but a read can still
// land before the very first scenario exists.
try { s = read(); } catch { try { s = read(); } catch { s = {}; } }
const r = s[args[0] + ' ' + args[1]] ?? s[args[0]] ?? { code: 1, stdout: '' };
process.stdout.write(String(r.stdout ?? '') + '\\n');
process.exit(r.code ?? 1);
`);
  fs.chmodSync(shim, 0o755);
  return { shim, scenario, calls };
}

// Atomic scenario swap: write-then-rename means a concurrent shim read (e.g.
// a grace-timer stop firing in the background) sees the old or the new
// scenario, never a half-written file.
function writeScenario(scenarioPath, map) {
  const tmp = `${scenarioPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, scenarioPath);
}

// Drives a harness in --warm mode: several invokes through one process,
// using the same framing server/runtime/pool.js uses. Returns each invoke's
// envelope and, separately, the logs the parent would have attributed to it.
async function driveWarmHarness({ cmd, args, cwd, events, env }) {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const { randomUUID } = require('node:crypto');
  const { encodeRequest, sentinelFor } = require('../server/runtime/protocol');

  const results = [];
  const logs = [];
  const child = spawn(cmd, args, {
    cwd, env: env ?? { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let buf = '';
  try {
    for (const event of events) {
      const requestId = randomUUID();
      const resultFile = path.join(os.tmpdir(), `awsplay-warmtest-${requestId}.json`);
      child.stdin.write(encodeRequest({ requestId, resultFile, event, timeoutMs: 5000, memoryMb: 128 }));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no sentinel; buffer so far: ${JSON.stringify(buf)}`)), 15000);
        const onData = (d) => {
          buf += d;
          const marker = sentinelFor(requestId);
          const at = buf.indexOf(marker);
          if (at === -1) return;
          clearTimeout(timer);
          child.stdout.off('data', onData);
          logs.push(buf.slice(0, at));
          buf = buf.slice(at + marker.length);
          resolve();
        };
        child.stdout.on('data', onData);
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`harness exited ${code} before answering; buffer: ${buf}`));
        });
      });
      results.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      fs.unlinkSync(resultFile);
    }
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
  }
  return { results, logs };
}

module.exports = { hasRuntime, writeDockerShim, writeScenario, driveWarmHarness };
