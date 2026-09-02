import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

function SettingsForm({ fn, onClose }: { fn: FunctionDef; onClose: () => void }) {
  const [name, setName] = useState(fn.name)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const [buildCommand, setBuildCommand] = useState(fn.buildCommand ?? '')
  const update = useUpdateFunction()

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
        },
      },
      { onSuccess: onClose },
    )
  }

  return (
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
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={update.isPending}>Save</Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function SettingsDialog({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      {open && <SettingsForm fn={fn} onClose={() => setOpen(false)} />}
    </Dialog>
  )
}
