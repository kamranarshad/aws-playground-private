import { ScrollArea } from '@/components/ui/scroll-area'
import { SpanLabel } from '@/components/span-label'
import { SPAN_GUTTER_PX, layoutSpans, spanDurationMs } from '@/lib/trace-layout'
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
            className="flex items-baseline gap-2 py-1.5 pr-3"
            style={{ paddingLeft: `${SPAN_GUTTER_PX}px` }}
          >
            <SpanLabel depth={depth} name={span.name} className="w-52 shrink-0 font-medium" />
            {/* Fixed track, right-aligned, tabular figures: the duration
                starts at the same x on every row instead of trailing
                whatever the name happened to be. */}
            <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
              {spanDurationMs(span).toFixed(2)}ms
            </span>
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
