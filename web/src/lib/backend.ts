import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// Works from web/src/lib (dev) and web/dist/server (built): walk up
// until the repo's server/ directory is found.
function serverDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'server', 'api.js'))) return path.join(dir, 'server')
    dir = path.dirname(dir)
  }
  throw new Error('could not locate server/api.js relative to the web build')
}

const req = createRequire(import.meta.url)
const SERVER_DIR = serverDir()
const API_PATH = path.join(SERVER_DIR, 'api.js')

function loadBackend() {
  return req(API_PATH)
}

function newestServerMtime(): number {
  let newest = 0
  for (const f of fs.readdirSync(SERVER_DIR)) {
    if (!f.endsWith('.js')) continue
    const t = fs.statSync(path.join(SERVER_DIR, f)).mtimeMs
    if (t > newest) newest = t
  }
  return newest
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: any = loadBackend()
let cachedAt = import.meta.env.DEV ? newestServerMtime() : 0

// Vite dev hot-reloads web/src but never these CJS modules, so a long-lived
// dev server serves stale backend code after a pull/merge (in-flight state
// like the invoke guard resets on reload — same as a restart would).
// Production (the built bundle) keeps the plain cached require.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function currentBackend(): any {
  if (!import.meta.env.DEV) return cached
  const newest = newestServerMtime()
  if (newest > cachedAt) {
    for (const key of Object.keys(req.cache)) {
      if (key.startsWith(SERVER_DIR + path.sep)) delete req.cache[key]
    }
    cached = loadBackend()
    cachedAt = newest
  }
  return cached
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const backend: any = new Proxy({}, {
  get(_t, prop) {
    return currentBackend()[prop]
  },
})

export function toResponse(result: { status: number; body?: unknown }): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status })
  }
  return Response.json(result.body, { status: result.status })
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => ({}))
}
