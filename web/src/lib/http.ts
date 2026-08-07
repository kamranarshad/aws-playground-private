// A response is "API Gateway proxy-shaped" when it carries an integer
// statusCode in the valid HTTP range; only then do we surface an HTTP badge.
export function httpStatusOf(response: unknown): number | null {
  if (typeof response !== 'object' || response === null) return null
  const status = (response as { statusCode?: unknown }).statusCode
  if (typeof status !== 'number' || !Number.isInteger(status)) return null
  if (status < 100 || status > 599) return null
  return status
}

export function httpStatusClass(status: number): string {
  if (status < 300) return 'border-transparent bg-success/15 text-success'
  if (status < 400) return 'border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400'
  if (status < 500) return 'border-transparent bg-brand/15 text-brand'
  return 'border-transparent bg-destructive/15 text-destructive'
}
