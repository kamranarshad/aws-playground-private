export type Runtime = 'python' | 'node' | 'java' | 'provided'

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

/** Every server/api/* function returns this shape; the route handlers in
 *  web/src/routes/api.*.ts turn it into a Response. */
export interface ApiResult<T = unknown> {
  status: number
  body?: T
}

export interface InvokeError {
  type: string
  message: string
  stackTrace: string[]
}

export interface InvokeReport {
  requestId: string
  durationMs: number
  billedMs: number
  memoryMb: number
  timedOut: boolean
  /** false when this invoke reused a warm execution environment. */
  cold?: boolean
  initMs?: number
  buildMs?: number
}

export interface InvokeTrace {
  spans: unknown[]
  pending: boolean
  error?: string
}

/** What server/invoker.js returns and server/api/invoke.js decorates. Built
 *  up across branches rather than in one literal, which is why the JS needs
 *  an explicit annotation for checkJs to follow it. */
export interface InvokeOutcome {
  ok: boolean
  phase: string
  response?: unknown
  error?: InvokeError | null
  logs?: string
  report?: InvokeReport
  trace?: InvokeTrace | null
}

export interface PollerStatus {
  state: 'idle' | 'polling' | 'error' | 'listening'
  lastError: string | null
  lastPolledAt?: number | null
}
