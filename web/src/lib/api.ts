import type {
  Detection, FunctionDef, FunctionStats, Health, HistoryEntry, InvokeResult, ServicesStatus, Trace, TriggersStatus,
} from './types'

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
  /** Discard the warm execution environment before running, so module scope
   *  and /tmp start empty the way they do on a real cold start. */
  forceCold?: boolean
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
  listHistory: (id: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
    const query = params.toString() ? `?${params.toString()}` : ''
    return request<{ entries: HistoryEntry[] }>(`/api/functions/${id}/history${query}`)
  },
  getStats: (id: string) =>
    request<FunctionStats>(`/api/functions/${id}/stats`),
  clearHistory: (id: string) =>
    request<void>(`/api/functions/${id}/history`, { method: 'DELETE' }),
  getTrace: (id: string, requestId: string) =>
    request<{ trace: Trace | null }>(`/api/functions/${id}/history/${requestId}/trace`),
  listServices: () => request<ServicesStatus>('/api/services'),
  setSelection: (functionId: string | null) =>
    request<{ started: string[]; scheduledStop: string[] }>('/api/selection', {
      method: 'POST', body: JSON.stringify({ functionId }),
    }),
  startService: (name: string) =>
    request<{ state: string }>(`/api/services/${name}/start`, { method: 'POST' }),
  stopService: (name: string) =>
    request<{ state: string }>(`/api/services/${name}/stop`, { method: 'POST' }),
  listTriggerStatus: () => request<TriggersStatus>('/api/triggers'),
}
