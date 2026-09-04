import { Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AutoTraceToggle } from '@/components/auto-trace-toggle'
import { SettingsDialog } from '@/components/settings-dialog'
import { TriggerButton } from '@/components/trigger-button'
import { TriggerStatusBadge } from '@/components/trigger-status-badge'
import { TriggerToggle } from '@/components/trigger-toggle'
import { useDeleteFunction, useDetect, useFunctionStats, useTriggerStatus } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function FunctionHeader({ fn, onDeleted }: { fn: FunctionDef; onDeleted: () => void }) {
  const del = useDeleteFunction()
  const { data: triggerStatuses } = useTriggerStatus()
  const { data: stats } = useFunctionStats(fn.id)
  // A playground.json-declared trigger never touches fn.trigger, so the
  // status badge's visibility can't rely on fn.trigger?.enabled alone — it
  // needs the same signal TriggerButton uses to decide a trigger is active.
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)
  const triggerActive = projectTrigger != null || fn.trigger?.enabled
  const triggerStatus = triggerActive ? triggerStatuses?.[fn.id] : undefined
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <h2 className="truncate text-sm font-semibold">{fn.name}</h2>
      <Badge variant="secondary" className="font-mono">{fn.runtime}</Badge>
      {triggerStatus && <TriggerStatusBadge status={triggerStatus} />}
      {stats && stats.total > 0 && (
        <span
          className="hidden sm:inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-muted/60 text-[11px] font-mono text-muted-foreground tabular-nums"
          title={`Total: ${stats.total} | Errors: ${stats.failures} (${(stats.errorRate * 100).toFixed(1)}%) | p95: ${stats.p95DurationMs ?? 0}ms`}
        >
          <span>{stats.total} {stats.total === 1 ? 'run' : 'runs'}</span>
          {stats.failures > 0 && (
            <span className="text-destructive font-medium">({(stats.errorRate * 100).toFixed(0)}% err)</span>
          )}
          {stats.p95DurationMs != null && (
            <span>· p95 {stats.p95DurationMs}ms</span>
          )}
        </span>
      )}
      <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
        {fn.handler || 'no handler set'} · {fn.timeoutMs}ms · {fn.memoryMb}MB
      </span>
      <div className="ml-auto flex items-center gap-1">
        <TriggerButton fn={fn} />
        <AutoTraceToggle fn={fn} />
        <TriggerToggle fn={fn} />
        <SettingsDialog fn={fn} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Delete function">
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {fn.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the registration and its invoke history. The project folder is untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={del.isPending}
                onClick={(e) => {
                  // Keep the dialog open so the pending state stays visible;
                  // the header unmounts on success once the function is gone.
                  e.preventDefault()
                  del.mutate(fn.id, { onSuccess: onDeleted })
                }}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
