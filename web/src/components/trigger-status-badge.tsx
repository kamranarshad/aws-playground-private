import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { TriggerStatus } from '@/lib/types'

const STATE_LABEL: Record<TriggerStatus['state'], string> = {
  idle: 'Trigger: idle',
  polling: 'Trigger: polling',
  error: 'Trigger: error',
}

const STATE_CLASS: Record<TriggerStatus['state'], string> = {
  idle: 'border-transparent bg-muted text-muted-foreground',
  polling: 'border-transparent bg-success/15 text-success',
  error: 'border-transparent bg-destructive/15 text-destructive',
}

export function TriggerStatusBadge({ status }: { status: TriggerStatus }) {
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', STATE_CLASS[status.state])}
      title={status.lastError ?? undefined}>
      {STATE_LABEL[status.state]}
    </Badge>
  )
}
