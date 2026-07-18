const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
};

function staticFile(clientDir, urlPath) {
  const resolved = path.resolve(clientDir, '.' + urlPath);
  if (resolved !== clientDir && !resolved.startsWith(clientDir + path.sep)) return null;
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {}
  return null;
}

async function startWebServer({ distDir, port, host }) {
  const entryUrl = pathToFileURL(path.join(distDir, 'server', 'server.js')).href;
  const clientDir = path.join(distDir, 'client');
  const mod = await import(entryUrl);
  const entry = mod.default ?? mod;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = staticFile(clientDir, urlPath);
        if (file) {
          const stream = fs.createReadStream(file);
          stream.on('error', () => { res.destroy(); });
          res.writeHead(200, {
            'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          });
          if (req.method === 'HEAD') { stream.destroy(); return res.end(); }
          return stream.pipe(res);
        }
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await entry.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => { res.appendHeader(key, value); });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`aws-playground web server error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

module.exports = { startWebServer };
