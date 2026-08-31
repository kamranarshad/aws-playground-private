import { ScrollArea } from '@/components/ui/scroll-area'
import { layoutSpans, spanDurationMs } from '@/lib/trace-layout'
import type { Span } from '@/lib/types'

export function TracePanel({ spans, error }: { spans: Span[]; error?: string | null }) {
  if (spans.length === 0) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        {error ?? 'No spans received — export to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT from your handler to see spans here.'}
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y font-mono text-xs">
        {layoutSpans(spans).map(({ span, depth }) => (
          <li
            key={span.spanId}
            className="flex items-baseline gap-2 px-3 py-1.5"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
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
