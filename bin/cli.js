#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startWebServer } = require('../server/serve-web');
const localServices = require('../server/services');
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

  --port <n>   Port to listen on (default 4590)
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

const port = parseInt(optValue('--port', '4590'), 10);
if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error('aws-playground: invalid --port value');
  process.exit(1);
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

startWebServer({ distDir: DIST, port, host: '127.0.0.1' })
  .then((server) => {
    installShutdownSweep(server);
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
      console.error(`Port ${port} is already in use. Try: aws-playground --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });
