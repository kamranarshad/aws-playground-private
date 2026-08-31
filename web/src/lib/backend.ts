import { createRequire } from 'node:module'
import type { ApiResult, FunctionDef, Ports } from '@aws-playground/server/types'

// server/ is CommonJS with no HTTP server of its own -- every route under
// web/src/routes/api.*.ts calls straight into it in-process, rather than the
// web app proxying to a separately-running API process.
//
// It must NOT be bundled: the invoker resolves the harness directory from
// __dirname, so the modules have to be loaded from disk at runtime. Hence
// createRequire rather than an import.
const require_ = createRequire(import.meta.url)

export interface Backend {
  health(): Promise<ApiResult>
  listFunctions(): ApiResult<{ functions: FunctionDef[] }>
  createFunction(input: unknown): ApiResult<FunctionDef>
  updateFunction(id: string, patch: unknown): ApiResult<FunctionDef>
  deleteFunction(id: string): ApiResult
  detect(input: unknown): ApiResult
  invokeFunction(input: unknown): Promise<ApiResult>
  listHistory(id: string): ApiResult
  clearHistory(id: string): ApiResult
  getInvokeTrace(id: string, requestId: string): ApiResult
  listServices(): Promise<ApiResult>
  startService(name: string): Promise<ApiResult>
  stopService(name: string): Promise<ApiResult>
  setSelection(input: unknown): Promise<ApiResult>
  listTriggerStatus(): ApiResult
  startBootstrap(): Promise<void>
  RUNTIMES: string[]
  PORTS: Ports
}

export const backend: Backend = require_('@aws-playground/server')

// The CLI calls bootstrap.start() itself. Under `vite dev` there is no CLI,
// so without this the dev server serves a UI whose triggers never fire and
// whose S3 webhook listener is never bound.
if (import.meta.env.DEV) {
  backend.startBootstrap?.()
}

export function toResponse(result: { status: number; body?: unknown }): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status })
  }
  return Response.json(result.body, { status: result.status })
}

export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => ({}))
}
