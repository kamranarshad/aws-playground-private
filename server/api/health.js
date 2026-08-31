const { execFile } = require('child_process');
const { PORTS } = require('../ports');

function checkRuntime(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

async function health() {
  const [python, node, java, provided] = await Promise.all([
    checkRuntime('python3', ['--version']),
    checkRuntime('node', ['--version']),
    checkRuntime('java', ['-version']),
    checkRuntime('sh', ['-c', 'echo ok']),
  ]);
  return { status: 200, body: { runtimes: { python, node, java, provided }, ports: PORTS } };
}

module.exports = { health };
