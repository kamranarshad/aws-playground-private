import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHealth } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { Runtime } from '@/lib/types'

const LABELS: Record<Runtime, string> = { python: 'py', node: 'node', java: 'java', provided: 'os' }

export function HealthChips() {
  const { data } = useHealth()
  if (!data) return null
  return (
    <TooltipProvider>
      <div className="flex items-center gap-1.5">
        {(Object.keys(LABELS) as Runtime[]).map((rt) => {
          const info = data.runtimes[rt]
          return (
            <Tooltip key={rt}>
              <TooltipTrigger asChild>
                <Badge variant={info?.available ? 'secondary' : 'outline'}
                  className={cn('font-mono', info?.available ? '' : 'opacity-50 line-through')}>
                  {LABELS[rt]}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{info?.version ?? 'not found on PATH'}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
