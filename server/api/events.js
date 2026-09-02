/**
 * Server-Sent Events (SSE) broadcaster for real-time state synchronization.
 * Pushes updates to the web client whenever functions, triggers, services, or invokes change.
 */

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();
let heartbeatTimer = null;

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 25000);
  heartbeatTimer.unref?.();
}

/**
 * Handles an incoming SSE connection request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleEventsSubscription(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(': connected\n\n');
  clients.add(res);
  ensureHeartbeat();

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });
}

/**
 * Broadcasts an event with payload to all connected clients.
 *
 * @param {string} eventName
 * @param {unknown} [data]
 */
function broadcast(eventName, data = {}) {
  if (clients.size === 0) return;
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(clients)) {
    try {
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Closes all active client connections and resets the broadcaster.
 */
function closeAll() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const res of clients) {
    try { res.end(); } catch {}
  }
  clients.clear();
}

function clientCount() {
  return clients.size;
}

module.exports = {
  handleEventsSubscription,
  broadcast,
  closeAll,
  clientCount,
};
