import { Fragment, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  layoutSpans, spanDurationMs, spanOffsetMs, ticksFor, timelineBounds,
} from '@/lib/trace-layout'
import { cn } from '@/lib/utils'
import type { Span } from '@/lib/types'

const ROW_HEIGHT_PX = 24
// A percentage floor, not a pixel one -- keeps every bar's geometry
// expressible as a plain percentage string, so it stays testable without
// needing real layout/rendering to resolve a CSS calc().
const MIN_BAR_WIDTH_PCT = 0.5

function SpanDetail({ span }: { span: Span }) {
  return (
    <div className="border-t bg-surface-strip p-3 font-mono text-xs">
      <div className="mb-2 font-medium">{span.name}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>Duration</dt><dd>{spanDurationMs(span).toFixed(2)}ms</dd>
        <dt>Trace ID</dt><dd className="truncate">{span.traceId}</dd>
        <dt>Span ID</dt><dd className="truncate">{span.spanId}</dd>
        <dt>Parent ID</dt><dd className="truncate">{span.parentSpanId ?? '—'}</dd>
        <dt>Start (unix ns)</dt><dd className="truncate">{span.startTimeUnixNano}</dd>
        <dt>End (unix ns)</dt><dd className="truncate">{span.endTimeUnixNano}</dd>
        {Object.entries(span.attributes).map(([key, value]) => (
          <Fragment key={key}>
            <dt className="truncate">{key}</dt>
            <dd className="truncate">{JSON.stringify(value)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

export function TraceWaterfall({ spans }: { spans: Span[] }) {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)

  if (spans.length === 0) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        No spans received — export to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT from your handler to see spans here.
      </div>
    )
  }

  const rows = layoutSpans(spans)
  const bounds = timelineBounds(spans)
  // A zero-duration single span (or a set of identically-timed spans) would
  // otherwise divide by zero when computing percentages below.
  const totalMs = bounds.totalMs || 1
  const ticks = ticksFor(bounds.totalMs)
  const selectedSpan = spans.find((s) => s.spanId === selectedSpanId) ?? null

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="grid gap-x-2" style={{ gridTemplateColumns: '160px 1fr' }}>
          <div />
          <div className="relative mb-1 h-4 border-b border-border/40 text-[10px] text-muted-foreground">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-0 border-l border-border/40 pl-1"
                style={{ left: `${(t / totalMs) * 100}%` }}
              >
                {t}ms
              </span>
            ))}
          </div>
          {rows.map(({ span, depth }) => {
            const offsetPct = (spanOffsetMs(span, bounds) / totalMs) * 100
            const widthPct = Math.max((spanDurationMs(span) / totalMs) * 100, MIN_BAR_WIDTH_PCT)
            return (
              <Fragment key={span.spanId}>
                <div
                  className="truncate pr-2 font-mono text-[11px]"
                  style={{ height: ROW_HEIGHT_PX, lineHeight: `${ROW_HEIGHT_PX}px`, paddingLeft: `${depth * 12}px` }}
                >
                  {span.name}
                </div>
                <div className="relative" style={{ height: ROW_HEIGHT_PX }}>
                  <button
                    type="button"
                    data-testid={`trace-bar-${span.spanId}`}
                    onClick={() => setSelectedSpanId((id) => (id === span.spanId ? null : span.spanId))}
                    title={`${span.name} — ${spanDurationMs(span).toFixed(2)}ms`}
                    className={cn(
                      'absolute top-1/2 h-3 -translate-y-1/2 rounded-sm bg-brand/70 hover:bg-brand',
                      selectedSpanId === span.spanId && 'ring-2 ring-brand',
                    )}
                    style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                  />
                </div>
              </Fragment>
            )
          })}
        </div>
      </ScrollArea>
      {selectedSpan && <SpanDetail span={selectedSpan} />}
    </div>
  )
}
