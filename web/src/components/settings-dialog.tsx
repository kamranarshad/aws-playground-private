import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function SettingsDialog({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(fn.name)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const [buildCommand, setBuildCommand] = useState(fn.buildCommand ?? '')
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.queueName ?? '')
  const [triggerEnabled, setTriggerEnabled] = useState(fn.trigger?.enabled ?? false)
  const update = useUpdateFunction()

  useEffect(() => {
    // Re-seed from `fn` whenever the dialog opens, not just when the `fn`
    // object identity changes. React Query's structural sharing keeps the
    // same `fn` reference across a refetch that changes nothing (e.g. a
    // blank-name save that falls back to the current name), so relying on
    // `fn` alone left a stale, blank Name field the next time the dialog
    // was reopened even though the saved name was correct.
    if (!open) return
    setName(fn.name)
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
    setBuildCommand(fn.buildCommand ?? '')
    setTriggerQueueName(fn.trigger?.queueName ?? '')
    setTriggerEnabled(fn.trigger?.enabled ?? false)
  }, [open, fn])

  function save() {
    // Empty/garbage input (NaN) keeps the current value; an explicit 0 clamps
    // up to the minimum rather than silently reverting. A blank name keeps
    // the current name by the same rule.
    const t = parseInt(timeoutMs, 10)
    const m = parseInt(memoryMb, 10)
    update.mutate(
      {
        id: fn.id,
        patch: {
          name: name.trim() || fn.name,
          handler: handler.trim(),
          timeoutMs: Math.max(100, Number.isNaN(t) ? fn.timeoutMs : t),
          memoryMb: Math.max(128, Number.isNaN(m) ? fn.memoryMb : m),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
          buildCommand: buildCommand.trim(),
          trigger: triggerQueueName.trim()
            ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled: triggerEnabled }
            : null,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-handler">Handler</Label>
            <Input id="s-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-timeout">Timeout (ms)</Label>
            <Input id="s-timeout" type="number" min={100} step={1000} value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-memory">Memory (MB)</Label>
            <Input id="s-memory" type="number" min={128} step={64} value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)} />
          </div>
          {fn.runtime === 'java' && (
            <div className="grid gap-2">
              <Label htmlFor="s-jar">Jar path</Label>
              <Input id="s-jar" value={jarPath} onChange={(e) => setJarPath(e.target.value)}
                spellCheck={false} placeholder="auto-detected if empty" />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="s-build">Build command</Label>
            <Input id="s-build" value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              spellCheck={false} placeholder="e.g. npm run build (empty = none)" />
            <p className="text-xs text-muted-foreground">
              Runs in the project folder before every invoke.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-trigger-queue">SQS trigger queue</Label>
            <Input id="s-trigger-queue" value={triggerQueueName}
              onChange={(e) => setTriggerQueueName(e.target.value)}
              spellCheck={false} placeholder="queue name (empty = no trigger)" />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={triggerEnabled} disabled={!triggerQueueName.trim()}
                onCheckedChange={(v) => setTriggerEnabled(v === true)} />
              Invoke automatically when a message arrives
            </label>
            <p className="text-xs text-muted-foreground">
              Auto-starts the local SQS service (ElasticMQ) and creates the queue if it doesn't exist.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
