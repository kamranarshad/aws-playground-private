import { useState } from 'react'
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
import { useDetect, useUpdateFunction, useHealth } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

type TriggerType = 'none' | 'sqs' | 'http' | 'dynamodb' | 's3'

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

function TriggerDialogContent({ fn, onClose }: { fn: FunctionDef; onClose: () => void }) {
  const [triggerType, setTriggerType] = useState<TriggerType>(fn.trigger?.type ?? 'none')
  const [triggerQueueName, setTriggerQueueName] = useState(fn.trigger?.type === 'sqs' ? fn.trigger.queueName : '')
  const [triggerTableName, setTriggerTableName] = useState(fn.trigger?.type === 'dynamodb' ? fn.trigger.tableName : '')
  const [triggerBucket, setTriggerBucket] = useState(fn.trigger?.type === 's3' ? fn.trigger.bucket : '')
  const [triggerEvents, setTriggerEvents] = useState<('ObjectCreated' | 'ObjectRemoved')[]>(
    fn.trigger?.type === 's3' ? fn.trigger.events : [],
  )
  const [triggerPrefix, setTriggerPrefix] = useState(fn.trigger?.type === 's3' ? (fn.trigger.prefix ?? '') : '')
  const [triggerSuffix, setTriggerSuffix] = useState(fn.trigger?.type === 's3' ? (fn.trigger.suffix ?? '') : '')
  const update = useUpdateFunction()
  const { data: health } = useHealth()
  const httpPort = health?.ports?.httpTrigger

  function toggleEvent(event: 'ObjectCreated' | 'ObjectRemoved') {
    setTriggerEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]))
  }

  function save() {
    // This dialog only ever sets type/queue/table name — enabling/disabling
    // is TriggerToggle's job, so whatever's currently set is carried
    // through unchanged (a brand-new trigger starts disabled until armed
    // there).
    const enabled = fn.trigger?.enabled ?? false
    const trigger: FunctionDef['trigger'] = triggerType === 'sqs'
      ? (triggerQueueName.trim() ? { type: 'sqs', queueName: triggerQueueName.trim(), enabled } : null)
      : triggerType === 'dynamodb'
        ? (triggerTableName.trim() ? { type: 'dynamodb', tableName: triggerTableName.trim(), enabled } : null)
        : triggerType === 'http'
          ? { type: 'http', enabled }
          : triggerType === 's3'
            ? (triggerBucket.trim() && triggerEvents.length > 0
              ? {
                  type: 's3',
                  bucket: triggerBucket.trim(),
                  events: triggerEvents,
                  ...(triggerPrefix.trim() ? { prefix: triggerPrefix.trim() } : {}),
                  ...(triggerSuffix.trim() ? { suffix: triggerSuffix.trim() } : {}),
                  enabled,
                }
              : null)
            : null
    update.mutate({ id: fn.id, patch: { trigger } }, { onSuccess: onClose })
  }

  return (
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
              <SelectItem value="dynamodb">DynamoDB Streams</SelectItem>
              <SelectItem value="s3">S3 bucket</SelectItem>
            </SelectContent>
          </Select>
          {triggerType === 'sqs' && (
            <>
              <Label htmlFor="t-trigger-queue">SQS trigger queue</Label>
              <Input id="t-trigger-queue" value={triggerQueueName}
                onChange={(e) => setTriggerQueueName(e.target.value)}
                spellCheck={false} placeholder="queue name (empty = no trigger)" />
              <p className="text-xs text-muted-foreground">
                Auto-starts the local SQS service (ElasticMQ) and creates the queue if it doesn't
                exist. Use the power button next to Trigger to turn it on.
              </p>
            </>
          )}
          {triggerType === 'dynamodb' && (
            <>
              <Label htmlFor="t-trigger-table">DynamoDB table</Label>
              <Input id="t-trigger-table" value={triggerTableName}
                onChange={(e) => setTriggerTableName(e.target.value)}
                spellCheck={false} placeholder="table name (empty = no trigger)" />
              <p className="text-xs text-muted-foreground">
                Auto-starts the local DynamoDB service and enables the table's stream if it
                isn't already — the table itself must already exist. Use the power button next
                to Trigger to turn it on.
              </p>
            </>
          )}
          {triggerType === 'http' && (
            <>
              <Label htmlFor="t-trigger-url">HTTP trigger URL</Label>
              <Input id="t-trigger-url" readOnly
                value={httpPort === undefined ? '' : `http://localhost:${httpPort}/${fn.name}/...`}
                spellCheck={false} onFocus={(e) => e.target.select()} />
              <p className="text-xs text-muted-foreground">
                Shares one listener on port {httpPort ?? '\u2026'} across every function with an
                HTTP trigger enabled, routed by name — names must be unique. Use the power
                button next to Trigger to turn it on.
              </p>
            </>
          )}
          {triggerType === 's3' && (
            <>
              <Label htmlFor="t-trigger-bucket">S3 bucket</Label>
              <Input id="t-trigger-bucket" value={triggerBucket}
                onChange={(e) => setTriggerBucket(e.target.value)}
                spellCheck={false} placeholder="bucket name (empty = no trigger)" />
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox id="t-trigger-created" checked={triggerEvents.includes('ObjectCreated')}
                    onCheckedChange={() => toggleEvent('ObjectCreated')} />
                  <Label htmlFor="t-trigger-created" className="text-sm font-normal">Object Created</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="t-trigger-removed" checked={triggerEvents.includes('ObjectRemoved')}
                    onCheckedChange={() => toggleEvent('ObjectRemoved')} />
                  <Label htmlFor="t-trigger-removed" className="text-sm font-normal">Object Removed</Label>
                </div>
              </div>
              <Label htmlFor="t-trigger-prefix">Key prefix (optional)</Label>
              <Input id="t-trigger-prefix" value={triggerPrefix}
                onChange={(e) => setTriggerPrefix(e.target.value)} spellCheck={false} placeholder="e.g. images/" />
              <Label htmlFor="t-trigger-suffix">Key suffix (optional)</Label>
              <Input id="t-trigger-suffix" value={triggerSuffix}
                onChange={(e) => setTriggerSuffix(e.target.value)} spellCheck={false} placeholder="e.g. .png" />
              <p className="text-xs text-muted-foreground">
                Auto-creates the bucket if it doesn't exist and wires up a MinIO webhook to a shared
                listener. Use the power button next to Trigger to turn it on.
              </p>
            </>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={update.isPending}>Save</Button>
      </DialogFooter>
    </DialogContent>
  )
}

function TriggerPicker({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Configure trigger">
          <Webhook className="size-4" />
        </Button>
      </DialogTrigger>
      {open && <TriggerDialogContent fn={fn} onClose={() => setOpen(false)} />}
    </Dialog>
  )
}
