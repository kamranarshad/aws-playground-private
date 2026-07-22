import { Database, ExternalLink, Loader2, Play, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServiceAction, useServices } from '@/lib/queries'
import { cn } from '@/lib/utils'

const STATE_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  stopped: 'bg-amber-500',
  absent: 'bg-muted-foreground/40',
  unavailable: 'bg-muted-foreground/40',
}

export function ServicesMenu() {
  const { data, refetch } = useServices()
  const action = useServiceAction()

  return (
    <DropdownMenu onOpenChange={(open) => open && refetch()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Local services">
          <Database className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="font-mono text-xs uppercase tracking-wide">
          Local services
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!data ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Checking docker…</p>
        ) : !data.docker.available ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Docker is not available. Install/start Docker to run local AWS-equivalent
            services like MinIO.
          </p>
        ) : (
          data.services.map((svc) => (
            <div key={svc.name} className="px-2 py-2">
              <div className="flex items-center gap-2">
                <span className={cn('size-2 shrink-0 rounded-full', STATE_DOT[svc.state])} />
                <span className="text-sm font-medium">{svc.label}</span>
                <Badge variant="outline" className="text-[10px]">{svc.state}</Badge>
                <span className="ml-auto" />
                {svc.state === 'running' ? (
                  <Button size="sm" variant="ghost" disabled={action.isPending}
                    onClick={() => action.mutate({ name: svc.name, action: 'stop' })}>
                    {action.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={action.isPending}
                    onClick={() => action.mutate({ name: svc.name, action: 'start' })}>
                    {action.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Start
                  </Button>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 pl-4">
                <span className="font-mono text-xs text-muted-foreground">{svc.endpoint}</span>
                {svc.state === 'running' && (
                  <a href={svc.consoleUrl} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                    Open console <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              {svc.state === 'running' && (
                <p className="mt-1 pl-4 text-xs text-muted-foreground">
                  Console login: playground / playground123
                </p>
              )}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
