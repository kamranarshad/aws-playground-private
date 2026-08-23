export type Runtime = 'python' | 'node' | 'java' | 'provided'

export interface SavedEvent {
  name: string
  event: unknown
}

export interface FunctionDef {
  id: string
  name: string
  path: string
  runtime: Runtime
  handler: string
  timeoutMs: number
  memoryMb: number
  jarPath: string | null
  env: Record<string, string>
  envFile: string
  buildCommand: string
  localServices: string[]
  savedEvents: SavedEvent[]
}

export interface ServiceCredential {
  label: string
  value: string
}

export interface LocalService {
  name: string
  label: string
  shortLabel: string
  note: string | null
  state: 'running' | 'stopped' | 'absent' | 'unavailable'
  endpoint: string
  consoleUrl: string | null
  credentials: ServiceCredential[]
}

export interface ServicesStatus {
  docker: { available: boolean }
  services: LocalService[]
}

export interface RuntimeHealth {
  available: boolean
  version: string | null
}

export interface Health {
  runtimes: Record<Runtime, RuntimeHealth>
}

export interface Detection {
  error?: string
  runtime: Runtime | null
  handlerCandidates: string[]
  venvPython?: string | null
  jarPath?: string | null
  envFiles?: string[]
  buildCommand?: string | null
  projectServices?: string[] | null
}

export interface LambdaError {
  type: string
  message: string
  stackTrace: string[]
}

export interface Report {
  requestId: string
  durationMs: number
  billedMs: number
  memoryMb: number
  timedOut: boolean
  buildMs?: number
}

export interface InvokeResult {
  ok: boolean
  // 'service' and 'build' are failures before the handler ever runs:
  // a required local service isn't up, or the build command failed.
  phase: 'init' | 'invoke' | 'build' | 'service'
  response?: unknown
  error?: LambdaError
  logs: string
  report: Report
}

export interface HistoryEntry {
  id: string
  ts: number
  handler: string
  event: unknown
  eventTruncated: boolean
  response?: unknown
  responseTruncated: boolean
  error?: LambdaError | null
  logs: string
  report: Report | null
  durationMs: number | null
  ok: boolean
  truncated: boolean
}
