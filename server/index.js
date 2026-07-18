const express = require('express');
const path = require('path');
const api = require('./api');

function send(res, result) {
  if (result.status === 204) return res.status(204).end();
  res.status(result.status).json(result.body);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', async (req, res) => send(res, await api.health()));
  app.get('/api/functions', (req, res) => send(res, api.listFunctions()));
  app.post('/api/functions', (req, res) => send(res, api.createFunction(req.body || {})));
  app.patch('/api/functions/:id', (req, res) => send(res, api.updateFunction(req.params.id, req.body || {})));
  app.delete('/api/functions/:id', (req, res) => send(res, api.deleteFunction(req.params.id)));
  app.post('/api/detect', (req, res) => send(res, api.detect(req.body || {})));
  app.post('/api/invoke', async (req, res) => send(res, await api.invokeFunction(req.body || {})));
  app.get('/api/functions/:id/history', (req, res) => send(res, api.listHistory(req.params.id)));
  app.delete('/api/functions/:id/history', (req, res) => send(res, api.clearHistory(req.params.id)));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp };
