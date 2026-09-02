const backend = require('./index');
const { handleEventsSubscription, broadcast } = require('./events');

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const str = Buffer.concat(chunks).toString('utf8');
  if (!str.trim()) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

/**
 * Dispatches an incoming HTTP request to the internal API handlers.
 * Returns true if the request was an API request and was handled, false otherwise.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
async function handleApiRequest(req, res) {
  let urlObj;
  try {
    urlObj = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request URL');
    return true;
  }

  const pathname = decodeURIComponent(urlObj.pathname);
  if (!pathname.startsWith('/api/') && pathname !== '/api') {
    return false;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/events') {
      handleEventsSubscription(req, res);
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const result = await backend.health();
      sendJson(res, result.status, result.body);
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/functions') {
      const result = backend.listFunctions();
      sendJson(res, result.status, result.body);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/functions') {
      const body = await readJsonBody(req);
      const result = backend.createFunction(body);
      sendJson(res, result.status, result.body);
      if (result.status === 201 || result.status === 200) {
        broadcast('functions', result.body);
      }
      return true;
    }

    if (pathname.startsWith('/api/functions/')) {
      const sub = pathname.slice('/api/functions/'.length);
      const parts = sub.split('/');
      const id = parts[0];

      if (parts.length === 1) {
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const result = backend.updateFunction(id, body);
          sendJson(res, result.status, result.body);
          if (result.status === 200) broadcast('functions', result.body);
          return true;
        }
        if (req.method === 'DELETE') {
          const result = backend.deleteFunction(id);
          if (result.status === 204) sendEmpty(res, 204);
          else sendJson(res, result.status, result.body);
          if (result.status === 204) broadcast('functions', { id });
          return true;
        }
      }

      if (parts.length === 2 && parts[1] === 'stats') {
        if (req.method === 'GET') {
          const result = backend.getFunctionStats(id);
          sendJson(res, result.status, result.body);
          return true;
        }
      }

      if (parts.length === 2 && parts[1] === 'history') {
        if (req.method === 'GET') {
          const limitParam = urlObj.searchParams.get('limit');
          const offsetParam = urlObj.searchParams.get('offset');
          const opts = {};
          if (limitParam !== null) opts.limit = parseInt(limitParam, 10);
          if (offsetParam !== null) opts.offset = parseInt(offsetParam, 10);
          const result = backend.listHistory(id, opts);
          sendJson(res, result.status, result.body);
          return true;
        }
        if (req.method === 'DELETE') {
          const result = backend.clearHistory(id);
          if (result.status === 204) sendEmpty(res, 204);
          else sendJson(res, result.status, result.body);
          if (result.status === 204) broadcast('history', { functionId: id });
          return true;
        }
      }

      if (parts.length === 4 && parts[1] === 'history' && parts[3] === 'trace') {
        const requestId = parts[2];
        if (req.method === 'GET') {
          const result = backend.getInvokeTrace(id, requestId);
          sendJson(res, result.status, result.body);
          return true;
        }
      }
    }

    if (req.method === 'POST' && pathname === '/api/detect') {
      const body = await readJsonBody(req);
      const result = backend.detect(body);
      sendJson(res, result.status, result.body);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/invoke') {
      const body = await readJsonBody(req);
      const result = await backend.invokeFunction(body);
      sendJson(res, result.status, result.body);
      if (result.status === 200) broadcast('history', { functionId: body?.functionId });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/services') {
      const result = await backend.listServices();
      sendJson(res, result.status, result.body);
      return true;
    }

    if (pathname.startsWith('/api/services/')) {
      const sub = pathname.slice('/api/services/'.length);
      const parts = sub.split('/');
      const name = parts[0];
      if (parts[1] === 'start' && req.method === 'POST') {
        const result = await backend.startService(name);
        sendJson(res, result.status, result.body);
        if (result.status === 200) broadcast('services', result.body);
        return true;
      }
      if (parts[1] === 'stop' && req.method === 'POST') {
        const result = await backend.stopService(name);
        sendJson(res, result.status, result.body);
        if (result.status === 200) broadcast('services', result.body);
        return true;
      }
    }

    if (req.method === 'POST' && pathname === '/api/selection') {
      const body = await readJsonBody(req);
      const result = await backend.setSelection(body);
      sendJson(res, result.status, result.body);
      if (result.status === 200) broadcast('services', result.body);
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/triggers') {
      const result = backend.listTriggerStatus();
      sendJson(res, result.status, result.body);
      return true;
    }

    sendJson(res, 404, { error: `Not Found: ${pathname}` });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    return true;
  }
}

module.exports = { handleApiRequest };
