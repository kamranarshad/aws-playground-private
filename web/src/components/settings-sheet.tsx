import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function SettingsSheet({ fn }: { fn: FunctionDef }) {
  const [open, setOpen] = useState(false)
  const [handler, setHandler] = useState(fn.handler)
  const [timeoutMs, setTimeoutMs] = useState(String(fn.timeoutMs))
  const [memoryMb, setMemoryMb] = useState(String(fn.memoryMb))
  const [jarPath, setJarPath] = useState(fn.jarPath ?? '')
  const update = useUpdateFunction()

  useEffect(() => {
    setHandler(fn.handler)
    setTimeoutMs(String(fn.timeoutMs))
    setMemoryMb(String(fn.memoryMb))
    setJarPath(fn.jarPath ?? '')
  }, [fn])

  function save() {
    // Empty/garbage input (NaN) keeps the current value; an explicit 0 clamps
    // up to the minimum rather than silently reverting.
    const t = parseInt(timeoutMs, 10)
    const m = parseInt(memoryMb, 10)
    update.mutate(
      {
        id: fn.id,
        patch: {
          handler: handler.trim(),
          timeoutMs: Math.max(100, Number.isNaN(t) ? fn.timeoutMs : t),
          memoryMb: Math.max(128, Number.isNaN(m) ? fn.memoryMb : m),
          jarPath: fn.runtime === 'java' ? (jarPath.trim() || null) : fn.jarPath,
        },
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Function settings">
          <Settings2 className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Settings — {fn.name}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 px-4">
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
        </div>
        <SheetFooter>
          <Button onClick={save} disabled={update.isPending}>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
