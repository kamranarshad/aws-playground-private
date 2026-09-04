const { execFile } = require('child_process');
const net = require('net');
const { REGISTRY, entry } = require('./registry');

function dockerBin() {
  return process.env.AWS_PLAYGROUND_DOCKER || 'docker';
}

function docker(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(dockerBin(), args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      });
    });
  });
}

async function status(name) {
  const svc = entry(name);
  const r = await docker(['inspect', '--format', '{{.State.Running}}', svc.container]);
  if (r.code !== 0) return 'absent';
  return r.output.includes('true') ? 'running' : 'stopped';
}

// Every service's state from one `docker ps -a`, which also doubles as the
// daemon liveness check (it fails exactly when `docker info` would).
// Returns null when docker is unavailable. Callers that poll — the services
// list, selection sync — use this instead of `docker info` plus one
// `docker inspect` per service, which was six process spawns per poll.
async function statusAll() {
  const r = await docker(['ps', '-a', '--format', '{{.Names}} {{.State}}']);
  if (r.code !== 0) return null;
  const byContainer = new Map();
  for (const line of r.output.split('\n')) {
    const [container, state] = line.trim().split(/\s+/);
    // docker's State is running/exited/created/paused/restarting/dead;
    // everything that isn't running is 'stopped', as `docker inspect
    // {{.State.Running}}` reported it before.
    if (container) byContainer.set(container, state === 'running' ? 'running' : 'stopped');
  }
  const states = new Map();
  for (const [name, svc] of Object.entries(REGISTRY)) {
    states.set(name, byContainer.get(svc.container) ?? 'absent');
  }
  return states;
}

function tcpReachable(target) {
  const [host, port] = target.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function waitReady(ready, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready.type === 'tcp') {
      if (await tcpReachable(ready.target)) return true;
    } else {
      // Any HTTP response counts: DynamoDB Local answers GET / with 400.
      // Bounded so a service that accepts the connection but never answers
      // can't hang this past the overall deadline.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(),
        Math.max(1, Math.min(deadline - Date.now(), 5000)));
      try {
        await fetch(ready.target, { signal: controller.signal });
        return true;
      } catch {} finally {
        clearTimeout(abortTimer);
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

module.exports = { dockerBin, docker, status, statusAll, tcpReachable, waitReady };
