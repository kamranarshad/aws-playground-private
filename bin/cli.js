#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startWebServer } = require('../server/serve-web');
const bootstrap = require('../server/bootstrap');
const { nodeVersionOk, nodeVersionMessage } = require('../server/runtime/node-version');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (!nodeVersionOk(process.version)) {
  console.error(nodeVersionMessage(process.version));
  process.exit(1);
}

if (args[0] === 'invoke') {
  const target = args[1];
  if (!target || target === '--help' || target === '-h') {
    console.log(`Usage: aws-playground invoke <function-name-or-id> [--event <json-or-path>] [--cold] [--json]

Invokes a function headlessly from the command line without starting the web UI.

  --event <json|path>  Event payload JSON string or path to JSON file (default: {})
  --cold               Force cold start (discard warm environment)
  --json               Output only the response payload as JSON`);
    process.exit(0);
  }

  const store = require('../server/persistence/store');
  const backend = require('../server/api/index');

  const functions = store.list();
  const fn = functions.find((f) => f.id === target || f.name === target);
  if (!fn) {
    console.error(`aws-playground: function "${target}" not found.`);
    process.exit(1);
  }

  let event = {};
  const eventArg = optValue('--event', null);
  if (eventArg) {
    const candidatePath = path.resolve(process.cwd(), eventArg);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      try {
        event = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      } catch (err) {
        console.error(`aws-playground: failed to parse event file "${eventArg}": ${err.message}`);
        process.exit(1);
      }
    } else {
      try {
        event = JSON.parse(eventArg);
      } catch (err) {
        console.error(`aws-playground: invalid JSON for --event: ${err.message}`);
        process.exit(1);
      }
    }
  }

  const forceCold = flag('--cold');
  const jsonOnly = flag('--json');

  backend.invokeFunction({ functionId: fn.id, event, forceCold })
    .then((result) => {
      if (result.status !== 200) {
        console.error(`aws-playground invoke error (${result.status}):`, result.body?.error || result.body);
        process.exit(1);
      }
      const inv = result.body;
      if (jsonOnly) {
        console.log(JSON.stringify(inv.response, null, 2));
      } else {
        if (inv.logs) process.stdout.write(inv.logs);
        if (!inv.ok) {
          console.error('Invoke Failed:', inv.error);
          process.exit(1);
        }
        console.log(JSON.stringify(inv.response, null, 2));
      }
      process.exit(inv.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('aws-playground invoke failed:', err.message);
      process.exit(1);
    });
  return;
}

if (args[0] === 'list') {
  if (flag('--help') || flag('-h')) {
    console.log(`Usage: aws-playground list [--json]

Lists all registered functions and their configured triggers.`);
    process.exit(0);
  }
  const store = require('../server/persistence/store');
  const functions = store.list();
  if (flag('--json')) {
    console.log(JSON.stringify(functions, null, 2));
    process.exit(0);
  }
  if (functions.length === 0) {
    console.log('No functions registered.');
    process.exit(0);
  }
  console.log('NAME'.padEnd(20) + 'RUNTIME'.padEnd(12) + 'HANDLER'.padEnd(25) + 'TRIGGER'.padEnd(15) + 'PATH');
  console.log('-'.repeat(85));
  for (const fn of functions) {
    const trigStr = fn.trigger ? `${fn.trigger.type} (${fn.trigger.enabled ? 'on' : 'off'})` : 'none';
    console.log(
      fn.name.padEnd(20) +
      fn.runtime.padEnd(12) +
      (fn.handler || '').padEnd(25) +
      trigStr.padEnd(15) +
      (fn.path || '')
    );
  }
  process.exit(0);
}

if (args[0] === 'services') {
  const sub = args[1];
  if (!sub || sub === 'list') {
    const services = require('../server/services');
    services.list().then((result) => {
      if (flag('--json')) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }
      console.log(`Docker: ${result.docker.available ? 'Available' : 'Unavailable'}\n`);
      console.log('SERVICE'.padEnd(15) + 'STATUS'.padEnd(14) + 'ENDPOINT'.padEnd(30) + 'CONTAINER');
      console.log('-'.repeat(80));
      for (const s of result.services) {
        console.log(
          s.shortLabel.padEnd(15) +
          s.state.padEnd(14) +
          (s.endpoint || '-').padEnd(30) +
          (s.name || '')
        );
      }
      process.exit(0);
    }).catch((err) => {
      console.error('aws-playground services error:', err.message);
      process.exit(1);
    });
    return;
  }
  if (sub === 'start' || sub === 'stop') {
    const target = args[2];
    if (!target) {
      console.error(`Usage: aws-playground services ${sub} <service-name>`);
      process.exit(1);
    }
    const services = require('../server/services');
    const action = sub === 'start' ? services.start(target) : services.stop(target);
    action.then((res) => {
      console.log(`Service "${target}": ${res.state}`);
      process.exit(0);
    }).catch((err) => {
      console.error(`Failed to ${sub} service "${target}": ${err.message}`);
      process.exit(1);
    });
    return;
  }
  console.log(`Usage: aws-playground services [list] [--json]
       aws-playground services start <service-name>
       aws-playground services stop <service-name>

Manage local Docker-backed service containers (MinIO, SQS, DynamoDB, Redis, Postgres).`);
  process.exit(0);
}

if (flag('--help') || flag('-h')) {
  console.log(`Usage: aws-playground [--port <n>] [--no-open]
       aws-playground invoke <function-name-or-id> [--event <json-or-path>] [--cold] [--json]
       aws-playground list [--json]
       aws-playground services [list|start|stop] [service-name]

Starts the Lambda Playground server or manages functions and local services.

Commands:
  invoke <target>   Invokes a function headlessly without starting the web UI
  list              Lists all registered functions and triggers
  services [cmd]    Inspects or controls local Docker services (MinIO, DynamoDB, SQS, Redis, Postgres)

Options:
  --port <n>        Port to listen on (default: first available from 3000)
  --no-open         Do not open the browser automatically
  --event <data>    Event JSON string or file path for invoke
  --cold            Force cold start
  --json            Output only the response payload as JSON

From a source checkout, pass flags through npm: npm start -- --port 5000`);
  process.exit(0);
}

const DIST = path.join(__dirname, '..', 'web', 'dist');
if (!fs.existsSync(path.join(DIST, 'server', 'server.js'))) {
  console.error('aws-playground: web app not built (web/dist missing).');
  console.error('From a source checkout, run: npm install');
  process.exit(1);
}

const DEFAULT_PORT = 3000;
const portFlagProvided = flag('--port');
const port = parseInt(optValue('--port', String(DEFAULT_PORT)), 10);
if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error('aws-playground: invalid --port value');
  process.exit(1);
}

// When the caller didn't ask for a specific port, scan forward from the
// default until we find one that isn't taken, rather than failing outright.
async function startOnFirstAvailablePort(basePort, host, maxAttempts = 100) {
  for (let i = 0; i < maxAttempts && basePort + i <= 65535; i++) {
    try {
      return await startWebServer({ distDir: DIST, port: basePort + i, host });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw Object.assign(
    new Error(`no available port found from ${basePort} to ${basePort + maxAttempts - 1}`),
    { code: 'EADDRINUSE' },
  );
}
// Containers the playground auto-started belong to this process's lifetime.
// The grace timer that would normally stop them lives in here too, so
// quitting without a sweep leaves docker running with nothing to reap it.
function installShutdownSweep(server) {
  let shuttingDown = false;
  const bye = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    const stopped = await bootstrap.stop();
    if (stopped.length) {
      console.log(`aws-playground: stopped auto-started ${stopped.join(', ')}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

const HOST = '127.0.0.1';
(portFlagProvided
  ? startWebServer({ distDir: DIST, port, host: HOST })
  : startOnFirstAvailablePort(port, HOST))
  .then((server) => {
    installShutdownSweep(server);
    bootstrap.start();
    const url = `http://localhost:${server.address().port}`;
    console.log(`aws-playground listening at ${url}`);
    if (!flag('--no-open')) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
      spawn(opener, openArgs, { stdio: 'ignore', detached: true }).unref();
    }
  })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(portFlagProvided
        ? `Port ${port} is already in use. Try: aws-playground --port ${port + 1}`
        : `No available port found starting at ${port}. Try: aws-playground --port <n>`);
      process.exit(1);
    }
    throw err;
  });
