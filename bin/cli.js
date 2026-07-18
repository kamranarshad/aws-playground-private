#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startWebServer } = require('../server/serve-web');

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
  --no-open    Do not open the browser automatically`);
  process.exit(0);
}

const DIST = path.join(__dirname, '..', 'web', 'dist');
if (!fs.existsSync(path.join(DIST, 'server', 'server.js'))) {
  console.error('aws-playground: web app not built (web/dist missing).');
  console.error('From a source checkout, run: npm run build');
  process.exit(1);
}

const port = parseInt(optValue('--port', '4590'), 10);
startWebServer({ distDir: DIST, port, host: '127.0.0.1' })
  .then((server) => {
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
