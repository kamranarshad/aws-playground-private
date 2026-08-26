import { useEffect, useMemo, useState } from 'react'
import CodeMirror, { keymap, Prec } from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { Play, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CopyIcon } from '@/components/copy-icon'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { buildCurlCommand } from '@/lib/http'
import { EVENT_TEMPLATES } from '@/lib/templates'
import { useDetect, useUpdateFunction } from '@/lib/queries'
import { useCopy } from '@/lib/use-copy'
import { useTheme } from '@/lib/theme'
import type { FunctionDef } from '@/lib/types'

export function EventPanel({ fn, eventText, onEventTextChange, onInvoke, invoking }: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
}) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const update = useUpdateFunction()
  // Same "is this trigger actually reachable" check FunctionHeader uses for
  // its status badge — a playground.json trigger is always on, a manual one
  // only when its own enabled flag is set. Only then does
  // http://localhost:9500/<name> exist for a curl command to hit.
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)
  const httpTriggerActive = projectTrigger?.type === 'http'
    || (fn.trigger?.type === 'http' && fn.trigger.enabled)
  const { copied: curlCopied, copy: copyCurl } = useCopy()

  useEffect(() => setMounted(true), [])

  // CodeMirror's own default keymap binds Mod-Enter to insertBlankLine (its
  // documented Ctrl-/Cmd-Enter behavior) and runs it before the app's
  // window-level Cmd+Enter listener ever sees the event, so that listener's
  // preventDefault is too late to undo the blank line CodeMirror already
  // inserted. Prec.highest makes this binding win instead. stopPropagation
  // is required too: preventDefault alone stops the browser's own newline
  // but doesn't stop the event bubbling on to that window-level listener,
  // which would otherwise invoke a second time for the same keypress.
  const extensions = useMemo(() => [
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { onInvoke(); return true }, stopPropagation: true },
    ])),
    json(),
  ], [onInvoke])

  const jsonError = useMemo(() => {
    try {
      JSON.parse(eventText)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }, [eventText])

  function saveEvent() {
    const name = saveName.trim()
    if (!name) return
    const savedEvents = [
      ...fn.savedEvents.filter((s) => s.name !== name),
      { name, event: JSON.parse(eventText) },
    ]
    update.mutate({ id: fn.id, patch: { savedEvents } }, {
      onSuccess: () => {
        setSaveOpen(false)
        setSaveName('')
        toast.success(`Saved event "${name}"`)
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="m-1.5 flex items-center gap-1.5 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <Select value="" onValueChange={(name) =>
          onEventTextChange(JSON.stringify(EVENT_TEMPLATES[name], null, 2))}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Template…" /></SelectTrigger>
          <SelectContent>
            {Object.keys(EVENT_TEMPLATES).map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value="" onValueChange={(name) => {
          const saved = fn.savedEvents.find((s) => s.name === name)
          if (saved) onEventTextChange(JSON.stringify(saved.event, null, 2))
        }}>
          <SelectTrigger className="h-8 w-40 text-xs" disabled={fn.savedEvents.length === 0}>
            <SelectValue placeholder="Saved events…" />
          </SelectTrigger>
          <SelectContent>
            {fn.savedEvents.map((s) => (
              <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" disabled={!!jsonError}
          onClick={() => setSaveOpen(true)}>
          <Save className="size-3.5" /> Save
        </Button>
        {httpTriggerActive && (
          <Button variant="ghost" size="sm"
            onClick={() => copyCurl(buildCurlCommand(fn, eventText))}>
            <CopyIcon copied={curlCopied} className="size-3.5" /> Copy as curl
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {jsonError && (
            <span className="whitespace-nowrap text-xs text-destructive" title={jsonError}>
              invalid JSON
            </span>
          )}
          <Button size="sm" onClick={onInvoke} disabled={!!jsonError || invoking}>
            <Play className="size-3.5" /> {invoking ? 'Invoking…' : 'Invoke'}
            <kbd className="ml-1 font-mono text-[10px] opacity-70">⌘⏎</kbd>
          </Button>
        </div>
      </div>
      <div className="cm-host min-h-0 flex-1 overflow-auto font-mono text-sm">
        {mounted && (
          <CodeMirror value={eventText} height="100%" theme={theme}
            extensions={extensions} onChange={onEventTextChange} />
        )}
      </div>
      <Dialog open={saveOpen} onOpenChange={(o) => { setSaveOpen(o); if (!o) setSaveName('') }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Save event</DialogTitle></DialogHeader>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)}
            placeholder="Event name" autoComplete="off" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setSaveOpen(false); setSaveName('') }}>
              Cancel
            </Button>
            <Button onClick={saveEvent} disabled={!saveName.trim() || update.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
