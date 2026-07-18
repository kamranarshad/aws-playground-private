import type { Detection, FunctionDef, Health, HistoryEntry, InvokeResult } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText)
  return body as T
}

export interface InvokePayload {
  functionId: string
  event: unknown
  handler?: string
  envVars?: Record<string, string>
  timeoutMs?: number
  memoryMb?: number
}

export const api = {
  health: () => request<Health>('/api/health'),
  listFunctions: () => request<{ functions: FunctionDef[] }>('/api/functions'),
  createFunction: (input: Partial<FunctionDef>) =>
    request<FunctionDef>('/api/functions', { method: 'POST', body: JSON.stringify(input) }),
  updateFunction: (id: string, patch: Partial<FunctionDef>) =>
    request<FunctionDef>(`/api/functions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteFunction: (id: string) =>
    request<void>(`/api/functions/${id}`, { method: 'DELETE' }),
  detect: (path: string) =>
    request<Detection>('/api/detect', { method: 'POST', body: JSON.stringify({ path }) }),
  invoke: (payload: InvokePayload) =>
    request<InvokeResult>('/api/invoke', { method: 'POST', body: JSON.stringify(payload) }),
  listHistory: (id: string) =>
    request<{ entries: HistoryEntry[] }>(`/api/functions/${id}/history`),
  clearHistory: (id: string) =>
    request<void>(`/api/functions/${id}/history`, { method: 'DELETE' }),
}
