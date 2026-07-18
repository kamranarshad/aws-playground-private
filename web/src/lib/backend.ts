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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const backend: any = req(path.join(serverDir(), 'api.js'))

export function toResponse(result: { status: number; body?: unknown }): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status })
  }
  return Response.json(result.body, { status: result.status })
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => ({}))
}
