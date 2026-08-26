import { useEffect, useMemo, useState } from 'react'
import CodeMirror, { EditorView, keymap, Prec } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { ListChecks, Play, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { EVENT_TEMPLATES } from '@/lib/templates'
import { useUpdateFunction } from '@/lib/queries'
import { useTheme } from '@/lib/theme'
import type { FunctionDef, SavedEvent } from '@/lib/types'

// An aria-label prop on <CodeMirror> lands on the wrapper <div>, not on the
// contenteditable that actually carries role="textbox", so it never becomes
// the editor's accessible name. contentAttributes is CodeMirror's own hook for
// putting attributes on that element.
const SCRIPT_EDITOR_EXTENSIONS = [
  javascript(),
  EditorView.contentAttributes.of({ 'aria-label': 'Assertion script' }),
]

export function EventPanel({ fn, eventText, onEventTextChange, onInvoke, invoking, onLoadSavedEvent, canRunChecks, onRunChecks }: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
  onLoadSavedEvent: (saved: SavedEvent | null) => void
  canRunChecks: boolean
  onRunChecks: () => void
}) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveAssertionScript, setSaveAssertionScript] = useState('')
  const update = useUpdateFunction()

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

  // Re-saving an event under its own name rebuilds it from dialog state alone,
  // so an untouched dialog would silently drop the script it already had.
  // Both the "load a saved event" path and this comparison serialize with the
  // same JSON.stringify, so an unedited load matches exactly; once the user
  // hand-edits, nothing matches and the field stays blank — correct, because
  // an edited event is no longer that saved event.
  function scriptForCurrentEvent(): string {
    try {
      const current = JSON.stringify(JSON.parse(eventText))
      return fn.savedEvents.find((s) => JSON.stringify(s.event) === current)?.assertionScript ?? ''
    } catch {
      return ''
    }
  }

  function saveEvent() {
    const name = saveName.trim()
    if (!name) return
    const assertionScript = saveAssertionScript.trim() || undefined
    const savedEvents = [
      ...fn.savedEvents.filter((s) => s.name !== name),
      {
        name,
        event: JSON.parse(eventText),
        ...(assertionScript !== undefined && { assertionScript }),
      },
    ]
    update.mutate({ id: fn.id, patch: { savedEvents } }, {
      onSuccess: () => {
        setSaveOpen(false)
        setSaveName('')
        setSaveAssertionScript('')
        toast.success(`Saved event "${name}"`)
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="m-1.5 flex items-center gap-1.5 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <Select value="" onValueChange={(name) => {
          onEventTextChange(JSON.stringify(EVENT_TEMPLATES[name], null, 2))
          onLoadSavedEvent(null)
        }}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Template…" /></SelectTrigger>
          <SelectContent>
            {Object.keys(EVENT_TEMPLATES).map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value="" onValueChange={(name) => {
          const saved = fn.savedEvents.find((s) => s.name === name)
          if (!saved) return
          onEventTextChange(JSON.stringify(saved.event, null, 2))
          onLoadSavedEvent(saved)
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
          onClick={() => { setSaveAssertionScript(scriptForCurrentEvent()); setSaveOpen(true) }}>
          <Save className="size-3.5" /> Save
        </Button>
        <Button variant="ghost" size="sm" disabled={!canRunChecks} onClick={onRunChecks}>
          <ListChecks className="size-3.5" /> Run checks
        </Button>
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
            extensions={extensions}
            onChange={(text) => { onEventTextChange(text); onLoadSavedEvent(null) }} />
        )}
      </div>
      <Dialog open={saveOpen} onOpenChange={(o) => {
        setSaveOpen(o)
        if (!o) { setSaveName(''); setSaveAssertionScript('') }
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Save event</DialogTitle></DialogHeader>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)}
            placeholder="Event name" autoComplete="off" />
          <div className="grid gap-2">
            <span className="text-sm font-medium">
              Assertion script <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <div className="cm-host overflow-hidden rounded-md border font-mono text-sm">
              {mounted && (
                <CodeMirror value={saveAssertionScript} height="96px" theme={theme}
                  extensions={SCRIPT_EDITOR_EXTENSIONS}
                  placeholder="expect(response.statusCode).toBe(200)"
                  onChange={setSaveAssertionScript} />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost"
              onClick={() => { setSaveOpen(false); setSaveName(''); setSaveAssertionScript('') }}>
              Cancel
            </Button>
            <Button onClick={saveEvent} disabled={!saveName.trim() || update.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
