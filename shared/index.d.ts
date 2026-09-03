export type Runtime = 'python' | 'node' | 'java' | 'provided'

export declare const RUNTIMES: Runtime[]

export interface SavedEvent {
  name: string
  event: unknown
  assertionScript?: string
}

export type FunctionTrigger =
  | { type: 'sqs'; queueName: string; enabled: boolean }
  | { type: 'http'; enabled: boolean }
  | { type: 'dynamodb'; tableName: string; enabled: boolean }
  | {
      type: 's3'
      bucket: string
      events: ('ObjectCreated' | 'ObjectRemoved')[]
      prefix?: string
      suffix?: string
      enabled: boolean
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
  trigger: FunctionTrigger | null
  savedEvents: SavedEvent[]
  autoTrace: boolean
}

/** Every function field a create/update request may set (everything but `id`). */
export declare const ALLOWED_KEYS: (keyof Omit<FunctionDef, 'id'>)[]

/** Defaults applied on create for every field not required in the request. */
export declare const DEFAULTS: Omit<FunctionDef, 'id' | 'name' | 'path' | 'runtime'>

export type ResultTab = 'response' | 'logs' | 'report' | 'trace' | 'checks' | 'history'

export declare const RESULT_TABS: ResultTab[]

export interface Ports {
  httpTrigger: number
  s3Webhook: number
  minio: number
  minioConsole: number
  dynamodb: number
  redis: number
  postgres: number
  elasticmq?: number
  elasticmqConsole?: number
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

export type InvokeError = LambdaError

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
  cold?: boolean
  initMs?: number
  buildMs?: number
}

export type InvokeReport = Report

export interface InvokeResult {
  ok: boolean
  phase: 'init' | 'invoke' | 'build' | 'service' | string
  response?: unknown
  error?: LambdaError | null
  logs: string
  report: Report
  trace?: Trace | null
}

export interface InvokeOutcome {
  ok: boolean
  phase: string
  response?: unknown
  error?: InvokeError | null
  logs?: string
  report?: InvokeReport
  trace?: Trace | null
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

export interface ApiResult<T = unknown> {
  status: number
  body?: T
}

export interface PollerStatus {
  state: 'idle' | 'polling' | 'error' | 'listening'
  lastError: string | null
  lastPolledAt?: number | null
}
