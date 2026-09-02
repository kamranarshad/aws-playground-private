export type {
  Runtime, SavedEvent, FunctionTrigger, FunctionDef, Ports,
} from '@aws-playground/server/types'
import type { FunctionTrigger, Ports, Runtime } from '@aws-playground/server/types'

export type ResultTab = 'response' | 'logs' | 'report' | 'trace' | 'checks' | 'history'
export const RESULT_TABS: ResultTab[] = ['response', 'logs', 'report', 'trace', 'checks', 'history']

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

export interface TriggerStatus {
  state: 'idle' | 'polling' | 'listening' | 'error'
  lastError: string | null
  lastPolledAt: number | null
}

export type TriggersStatus = Record<string, TriggerStatus>

export interface RuntimeHealth {
  available: boolean
  version: string | null
}

export interface Health {
  runtimes: Record<Runtime, RuntimeHealth>
  ports: Ports
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
  projectTrigger?: FunctionTrigger | null
}

export interface LambdaError {
  type: string
  message: string
  stackTrace: string[]
}

export interface Span {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, string | number | boolean>
}

export interface Trace {
  spans: Span[]
  pending: boolean
  // Set when auto-trace was requested but couldn't start (e.g. the OTel
  // auto-instrumentation packages aren't installed) -- the handler still ran,
  // it just produced no spans, and this says why.
  error?: string | null
}

export interface CheckResult {
  matcher: 'toBe' | 'toEqual' | 'toContain' | 'toMatch'
  actual: unknown
  expected: unknown
  pass: boolean
}

export interface Report {
  requestId: string
  durationMs: number
  billedMs: number
  memoryMb: number
  timedOut: boolean
  /** false when this invoke reused a warm execution environment. */
  cold?: boolean
  buildMs?: number
  initMs?: number
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
  trace?: Trace
}

export type InvokeSource =
  | { type: 'manual' }
  | { type: 'trigger'; messageId: string }
  | { type: 'trigger'; method: string; path: string }
  | { type: 'trigger'; bucket: string; key: string; eventName: string }

export interface HistoryEntry {
  id: string
  ts: number
  handler: string
  source: InvokeSource
  event: unknown
  eventTruncated: boolean
  response?: unknown
  responseTruncated: boolean
  error?: LambdaError | null
  logs: string
  report: Report | null
  trace?: Trace | null
  durationMs: number | null
  ok: boolean
  truncated: boolean
}

export interface FunctionStats {
  total: number
  successes: number
  failures: number
  errorRate: number
  avgDurationMs: number | null
  minDurationMs: number | null
  maxDurationMs: number | null
  p50DurationMs: number | null
  p95DurationMs: number | null
  p99DurationMs: number | null
}
