const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const { detectProject, findJar } = require('./detect');
const { invoke } = require('./invoker');

const RUNTIMES = ['python', 'node', 'java'];

function checkRuntime(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const inFlight = new Set();

  app.get('/api/health', async (req, res) => {
    const [python, node, java] = await Promise.all([
      checkRuntime('python3', ['--version']),
      checkRuntime('node', ['--version']),
      checkRuntime('java', ['-version']),
    ]);
    res.json({ runtimes: { python, node, java } });
  });

  app.get('/api/functions', (req, res) => res.json({ functions: store.list() }));

  app.post('/api/functions', (req, res) => {
    const { name, path: dir, runtime } = req.body || {};
    if (!name || !dir || !runtime) {
      return res.status(400).json({ error: 'name, path and runtime are required' });
    }
    if (!RUNTIMES.includes(runtime)) {
      return res.status(400).json({ error: `unsupported runtime '${runtime}'` });
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: `path is not a directory: ${dir}` });
    }
    res.status(201).json(store.create(req.body));
  });

  app.patch('/api/functions/:id', (req, res) => {
    const fn = store.update(req.params.id, req.body || {});
    if (!fn) return res.status(404).json({ error: 'function not found' });
    res.json(fn);
  });

  app.delete('/api/functions/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'function not found' });
    res.status(204).end();
  });

  app.post('/api/detect', (req, res) => {
    const dir = (req.body || {}).path;
    if (!dir) return res.status(400).json({ error: 'path is required' });
    res.json(detectProject(dir));
  });

  app.post('/api/invoke', async (req, res) => {
    const { functionId } = req.body || {};
    const fn = store.get(functionId);
    if (!fn) return res.status(404).json({ error: 'function not found' });
    if (inFlight.has(fn.id)) {
      return res.status(409).json({ error: 'an invoke is already in flight for this function' });
    }
    inFlight.add(fn.id);
    try {
      const result = await invoke({
        name: fn.name,
        dir: fn.path,
        runtime: fn.runtime,
        handler: req.body.handler ?? fn.handler,
        event: req.body.event ?? {},
        env: { ...fn.env, ...(req.body.envVars || {}) },
        timeoutMs: req.body.timeoutMs ?? fn.timeoutMs,
        memoryMb: req.body.memoryMb ?? fn.memoryMb,
        jarPath: fn.jarPath || findJar(fn.path),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      inFlight.delete(fn.id);
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp };
