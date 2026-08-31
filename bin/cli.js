#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startWebServer } = require('../server/serve-web');
const localServices = require('../server/services');
const triggerManager = require('../server/trigger/manager');
const s3Trigger = require('../server/trigger/s3');
const { invokeFunction } = require('../server/api/invoke');
const { nodeVersionOk, nodeVersionMessage } = require('../server/node-version');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (flag('--help') || flag('-h')) {
  console.log(`Usage: aws-playground [--port <n>] [--no-open]

Starts the Lambda Playground server and opens it in your browser.

  --port <n>   Port to listen on (default: first available from 3000)
  --no-open    Do not open the browser automatically

From a source checkout, pass flags through npm: npm start -- --port 5000`);
  process.exit(0);
}

if (!nodeVersionOk(process.version)) {
  console.error(nodeVersionMessage(process.version));
  process.exit(1);
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
    triggerManager.stopAll();
    try {
      const stopped = await localServices.stopAutoStarted();
      if (stopped.length) {
        console.log(`aws-playground: stopped auto-started ${stopped.join(', ')}`);
      }
    } catch (err) {
      console.warn(`aws-playground: could not stop auto-started services: ${err.message}`);
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
    triggerManager.resumeAll({ invokeFunction }).catch((err) => {
      console.warn(`aws-playground: could not resume triggers: ${err.message}`);
    });
    s3Trigger.createListener({
      routesFor: triggerManager.s3RoutesFor,
      invokeFunction,
    }).catch((err) => {
      console.warn(`aws-playground: could not start the S3 trigger listener: ${err.message}`);
      // Also report it into the trigger manager: without this, every function
      // with an S3 trigger keeps showing 'listening' in the UI even though no
      // event can ever reach it.
      triggerManager.setS3ListenerError(err);
    });
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
