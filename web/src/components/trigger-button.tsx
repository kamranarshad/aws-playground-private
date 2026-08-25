import { useEffect, useState } from 'react'
import { Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDetect, useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const HTTP_TRIGGER_PORT = 9500 // must match server/trigger/http.js's PORT

type TriggerType = 'none' | 'sqs' | 'http'

// Trigger configuration for a function — invoked automatically from an SQS
// queue or an HTTP request instead of only manually. A project
// playground.json wins over whatever's set here, the same way it wins over
// the local-service toggles, so when one is present this renders a
// read-only label instead of the picker — a control that couldn't change
// anything would be a lie.
export function TriggerButton({ fn }: { fn: FunctionDef }) {
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)

  if (projectTrigger != null) {
    return (
      <span
        className="flex items-center gap-1 rounded bg-surface-strip px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
        title="Declared in playground.json — edit the file to change"
      >
        {projectTrigger.type}
      </span>
    )
  }

  return <TriggerPicker fn={fn} />
}

function TriggerPicker({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [triggerType, setTriggerType] = useState<TriggerType>(fn.trigger?.type ?? 'none')
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
  const [triggerEnabled, setTriggerEnabled] = useState(fn.trigger?.enabled ?? false)
  const update = useUpdateFunction()

  useEffect(() => {
    // Re-seed from `fn` whenever the dialog opens — same reason
    // SettingsDialog does this for its own fields: React Query's
    // structural sharing can keep the same `fn` reference across a
    // refetch that changes nothing, so an effect keyed only on `fn`
    // identity can miss a reset.
    if (!open) return
    setTriggerType(fn.trigger?.type ?? 'none')
    setTriggerQueueName(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
    setTriggerEnabled(fn.trigger?.enabled ?? false)
  }, [open, fn])

  function save() {
    update.mutate(
      {
        id: fn.id,
        patch: {
          trigger: triggerType === 'sqs'
            ? (triggerQueueName.trim()
              ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled: triggerEnabled }
              : null)
            : triggerType === 'http'
              ? { type: 'http', enabled: triggerEnabled }
              : null,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Configure trigger">
          <Webhook className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger — {fn.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="t-trigger-type">Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
              <SelectTrigger id="t-trigger-type" size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="sqs">SQS queue</SelectItem>
                <SelectItem value="http">HTTP (API Gateway)</SelectItem>
              </SelectContent>
            </Select>
            {triggerType === 'sqs' && (
              <>
                <Label htmlFor="t-trigger-queue">SQS trigger queue</Label>
                <Input id="t-trigger-queue" value={triggerQueueName}
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
              </>
            )}
            {triggerType === 'http' && (
              <>
                <Label htmlFor="t-trigger-url">HTTP trigger URL</Label>
                <Input id="t-trigger-url" readOnly
                  value={`http://localhost:${HTTP_TRIGGER_PORT}/${fn.name}/...`}
                  spellCheck={false} onFocus={(e) => e.target.select()} />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={triggerEnabled}
                    onCheckedChange={(v) => setTriggerEnabled(v === true)} />
                  Invoke automatically on incoming requests
                </label>
                <p className="text-xs text-muted-foreground">
                  Shares one listener on port {HTTP_TRIGGER_PORT} across every function with an
                  HTTP trigger enabled, routed by name — names must be unique.
                </p>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
