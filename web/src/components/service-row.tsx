import { ExternalLink, Loader2, Play, Square } from 'lucide-react'
import { CopyableValue } from '@/components/copyable-value'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useServiceAction } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { LocalService } from '@/lib/types'

const STATE_DOT: Record<string, string> = {
  running: 'bg-success',
  stopped: 'bg-brand',
  absent: 'bg-muted-foreground/40',
  unavailable: 'bg-muted-foreground/40',
}

// Each row owns its mutation instance so a pending start/stop only marks
// that row's button as loading (a shared instance flagged all five).
export function ServiceActionButton({ name, running }: { name: string; running: boolean }) {
  const action = useServiceAction()
  const Icon = action.isPending ? Loader2 : running ? Square : Play
  return (
    <Button size="sm" variant="ghost" disabled={action.isPending}
      onClick={() => action.mutate({ name, action: running ? 'stop' : 'start' })}>
      <Icon className={cn('size-3.5', action.isPending && 'animate-spin')} />
      {running ? 'Stop' : 'Start'}
    </Button>
  )
}

export function ServiceRow({ svc, selected, selectable, onSelectedChange }: {
  svc: LocalService
  selected: boolean
  selectable: boolean
  onSelectedChange: (checked: boolean) => void
}) {
  const running = svc.state === 'running'
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Checkbox
        checked={selected}
        disabled={!selectable}
        onCheckedChange={(v) => onSelectedChange(v === true)}
        aria-label={selectable ? `Select ${svc.label}` : `${svc.label} is already running`}
      />
      <span className={cn('size-2 shrink-0 rounded-full', STATE_DOT[svc.state])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{svc.label}</span>
          <Badge variant="outline" className="text-[10px]">{svc.state}</Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs text-muted-foreground">{svc.endpoint}</span>
          {svc.note && (
            <span className="text-xs text-muted-foreground/70">{svc.note}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          {svc.credentials.length > 0 ? (
            svc.credentials.map((c) => (
              <span key={c.label} className="inline-flex items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {c.label}
                </span>
                <CopyableValue value={c.value} />
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground/60">no authentication</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {running && svc.consoleUrl && (
          <a href={svc.consoleUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
            Open console <ExternalLink className="size-3" />
          </a>
        )}
        <ServiceActionButton name={svc.name} running={running} />
      </div>
    </li>
  )
}
