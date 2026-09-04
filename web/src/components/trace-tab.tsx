import { TracePanel } from '@/components/trace-panel'
import { TraceWaterfall } from '@/components/trace-waterfall'
import { cn } from '@/lib/utils'
import type { Span } from '@/lib/types'

export type TraceView = 'list' | 'timeline'

const VIEW_BUTTON =
  'rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm'

export function TraceTab({ spans, error, view, onViewChange }: {
  spans: Span[]
  error?: string | null
  view: TraceView
  onViewChange: (view: TraceView) => void
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-end gap-1 border-b px-2 py-1">
        <button
          type="button"
          data-active={view === 'list'}
          className={cn(VIEW_BUTTON)}
          onClick={() => onViewChange('list')}
        >
          List
        </button>
        <button
          type="button"
          data-active={view === 'timeline'}
          className={cn(VIEW_BUTTON)}
          onClick={() => onViewChange('timeline')}
        >
          Timeline
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'list'
          ? <TracePanel spans={spans} error={error} />
          : <TraceWaterfall spans={spans} error={error} />}
      </div>
    </div>
  )
}
