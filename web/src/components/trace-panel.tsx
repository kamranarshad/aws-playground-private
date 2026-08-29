import { ScrollArea } from '@/components/ui/scroll-area'
import type { Span } from '@/lib/types'

function spanDurationMs(span: Span): number {
  const start = BigInt(span.startTimeUnixNano)
  const end = BigInt(span.endTimeUnixNano)
  return Number(end - start) / 1e6
}

// Walks parentSpanId links up to the root, capped by `seen` in case of a
// cycle (malformed input shouldn't infinite-loop the UI).
function depthOf(span: Span, byId: Map<string, Span>): number {
  let depth = 0
  let current = span
  const seen = new Set<string>()
  while (current.parentSpanId && byId.has(current.parentSpanId) && !seen.has(current.spanId)) {
    seen.add(current.spanId)
    current = byId.get(current.parentSpanId)!
    depth += 1
  }
  return depth
}

export function TracePanel({ spans }: { spans: Span[] }) {
  if (spans.length === 0) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        No spans received — export to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT from your handler to see spans here.
      </div>
    )
  }
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const sorted = [...spans].sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y font-mono text-xs">
        {sorted.map((span) => (
          <li
            key={span.spanId}
            className="flex items-baseline gap-2 px-3 py-1.5"
            style={{ paddingLeft: `${12 + depthOf(span, byId) * 16}px` }}
          >
            <span className="font-medium">{span.name}</span>
            <span className="text-muted-foreground">{spanDurationMs(span).toFixed(2)}ms</span>
            {Object.keys(span.attributes).length > 0 && (
              <span className="truncate text-muted-foreground/70">
                {Object.entries(span.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}
