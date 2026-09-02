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

const { handleApiRequest } = require('./api/router');

async function startWebServer({ distDir, port, host }) {
  const serverJs = path.join(distDir, 'server', 'server.js');
  const hasSsr = fs.existsSync(serverJs);
  let entry = null;
  if (hasSsr) {
    const entryUrl = pathToFileURL(serverJs).href;
    const mod = await import(entryUrl);
    entry = mod.default ?? mod;
  }
  const clientDir = fs.existsSync(path.join(distDir, 'client'))
    ? path.join(distDir, 'client')
    : distDir;
  const spaHtml = fs.existsSync(path.join(clientDir, 'index.html'))
    ? path.join(clientDir, 'index.html')
    : fs.existsSync(path.join(distDir, 'index.html'))
      ? path.join(distDir, 'index.html')
      : null;

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = String(req.headers.host ?? '');
      const hostname = hostHeader.replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Forbidden: invalid Host header');
      }

      if (await handleApiRequest(req, res)) {
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        let urlPath;
        try {
          urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          return res.end('Bad request path');
        }
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
        if (!entry && spaHtml) {
          const stream = fs.createReadStream(spaHtml);
          stream.on('error', () => { res.destroy(); });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          if (req.method === 'HEAD') { stream.destroy(); return res.end(); }
          return stream.pipe(res);
        }
      }
      if (entry) {
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
          method: req.method,
          // IncomingHttpHeaders allows string[] values, which HeadersInit's
          // type does not -- undici accepts them at runtime regardless.
          headers: /** @type {any} */ (req.headers),
          body: hasBody ? Readable.toWeb(req) : undefined,
          duplex: hasBody ? 'half' : undefined,
        });
        const response = await entry.fetch(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => { res.appendHeader(key, value); });
        res.end(Buffer.from(await response.arrayBuffer()));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`aws-playground web server error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  return server;
}

module.exports = { startWebServer };
