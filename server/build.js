const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Runs a project build command before invoke. Unlike the handler
// sandbox, builds get the full inherited environment: build tools
// (npm, tsc, esbuild) need the user's real PATH.
async function runBuild({ dir, command, timeoutMs = 60000 }) {
  const startedAt = Date.now();
  // spawn fails on the cwd, not the command, when the project folder has been
  // moved or deleted — and reports it as "spawn /bin/sh ENOENT", which reads
  // like the shell is missing. Check first so the message names the folder.
  if (!fs.existsSync(dir)) {
    return { ok: false, exitCode: null, durationMs: 0,
      output: `Project folder no longer exists: ${dir}\n`
        + 'Point the function at its current location, or re-register it.' };
  }
  const result = await new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, {
      cwd: dir,
      shell: true,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    child.on('error', (err) => resolve({ exitCode: null, spawnError: err }));
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });

  const durationMs = Math.round(Date.now() - startedAt);
  if (result.spawnError) {
    return { ok: false, exitCode: null, durationMs,
      output: `Could not run build command: ${result.spawnError.message}` };
  }
  let output = result.output;
  if (result.timedOut) {
    output += `\nBuild timed out after ${(timeoutMs / 1000).toFixed(0)}s`;
  }
  // A package-manager build in a project with no node_modules can never
  // succeed — point at the actual fix instead of the compiler's noise.
  if (result.exitCode !== 0 && /^(npm|npx|yarn|pnpm)\b/.test(command.trim()) &&
      !fs.existsSync(path.join(dir, 'node_modules'))) {
    output += `\nHint: this project has no node_modules — run 'npm install' in ${dir} first.`;
  }
  return {
    ok: !result.timedOut && result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs,
    output,
  };
}

module.exports = { runBuild };
