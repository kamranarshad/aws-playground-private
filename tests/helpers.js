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
