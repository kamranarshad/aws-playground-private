import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { useCreateFunction } from '@/lib/queries'
import type { Runtime } from '@/lib/types'

export function AddFunctionDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [runtime, setRuntime] = useState<Runtime>('python')
  const [handler, setHandler] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [error, setError] = useState('')
  const create = useCreateFunction()

  function reset() {
    setDir(''); setName(''); setRuntime('python'); setHandler('')
    setCandidates([]); setError('')
  }

  function cancel() {
    reset()
    onOpenChange(false)
  }

  async function runDetect() {
    if (!dir.trim()) return
    try {
      const d = await api.detect(dir.trim())
      if (d.error) {
        setError(`Not a directory: ${dir.trim()}`)
        return
      }
      setError('')
      if (d.runtime) setRuntime(d.runtime)
      // Detect runs after the path field blurs, so the user may have typed a
      // name/handler while the request was in flight. Only fill blanks — never
      // clobber what they entered — by checking the *current* state.
      const detectedName = dir.trim().split('/').filter(Boolean).pop() ?? ''
      setName((cur) => cur || detectedName)
      setCandidates(d.handlerCandidates.slice(0, 6))
      if (d.handlerCandidates.length > 0) {
        setHandler((cur) => cur || d.handlerCandidates[0])
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function submit() {
    create.mutate(
      { name: name.trim(), path: dir.trim(), runtime, handler: handler.trim() },
      {
        onSuccess: (fn) => {
          reset()
          onOpenChange(false)
          toast.success(`Registered ${fn.name}`)
          onCreated(fn.id)
        },
        onError: (e) => setError(e.message),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add function</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="fn-path">Project path</Label>
            <Input id="fn-path" value={dir} onChange={(e) => setDir(e.target.value)}
              onBlur={runDetect} placeholder="/absolute/path/to/project"
              spellCheck={false} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fn-name">Name</Label>
            <Input id="fn-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Function name" autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label>Runtime</Label>
            <Select value={runtime} onValueChange={(v) => setRuntime(v as Runtime)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="python">python</SelectItem>
                <SelectItem value="node">node</SelectItem>
                <SelectItem value="java">java</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fn-handler">Handler</Label>
            <Input id="fn-handler" value={handler} onChange={(e) => setHandler(e.target.value)}
              placeholder="e.g. app.handler" spellCheck={false} autoComplete="off" />
            {candidates.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {candidates.map((c) => (
                  <Button key={c} type="button" variant="outline" size="sm"
                    onClick={() => setHandler(c)}>
                    {c}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || !dir.trim() || !name.trim()}>
            {create.isPending ? 'Registering…' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
