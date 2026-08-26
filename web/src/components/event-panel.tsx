import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import CodeMirror, { EditorView, keymap, Prec } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { GripHorizontal, ListChecks, Play, Save } from 'lucide-react'
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

// An aria-label prop on <CodeMirror> lands on the wrapper <div>, not on the
// contenteditable that actually carries role="textbox", so it never becomes
// the editor's accessible name. contentAttributes is CodeMirror's own hook for
// putting attributes on that element.
const SCRIPT_EDITOR_EXTENSIONS = [
  javascript(),
  EditorView.contentAttributes.of({ 'aria-label': 'Assertion script' }),
]

const DEFAULT_SCRIPT_PANEL_HEIGHT = 96
const MIN_SCRIPT_PANEL_HEIGHT = 48
const MAX_SCRIPT_PANEL_HEIGHT = 400

export function EventPanel({ fn, eventText, onEventTextChange, onInvoke, invoking, onScriptChange, hasResult, onRunChecks }: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
  onScriptChange: (script: string) => void
  hasResult: boolean
  onRunChecks: (script: string) => void
}) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [scriptDraft, setScriptDraft] = useState('')
  const [scriptPanelHeight, setScriptPanelHeight] = useState(DEFAULT_SCRIPT_PANEL_HEIGHT)
  const update = useUpdateFunction()
  // Same "is this trigger actually reachable" check FunctionHeader uses for
  // its status badge — a playground.json trigger is always on, a manual one
  // only when its own enabled flag is set. Only then does
  // http://localhost:9500/<name> exist for a curl command to hit.
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)
  const httpTriggerActive = projectTrigger?.type === 'http'
    || (fn.trigger?.type === 'http' && fn.trigger.enabled)
  const { copied: curlCopied, copy: copyCurl } = useCopy()

  // Dragging the handle up should grow the script panel below it, so a
  // smaller clientY (moved up) must map to a larger height — hence the
  // subtraction rather than an addition.
  function startResizingScriptPanel(e: ReactPointerEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = scriptPanelHeight
    function onMove(ev: PointerEvent) {
      const next = startHeight - (ev.clientY - startY)
      setScriptPanelHeight(Math.min(MAX_SCRIPT_PANEL_HEIGHT, Math.max(MIN_SCRIPT_PANEL_HEIGHT, next)))
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

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

  function changeScript(text: string) {
    setScriptDraft(text)
    onScriptChange(text)
  }

  function saveEvent() {
    const name = saveName.trim()
    if (!name) return
    const assertionScript = scriptDraft.trim() || undefined
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
        toast.success(`Saved event "${name}"`)
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="m-1.5 flex items-center gap-1.5 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <Select value="" onValueChange={(name) => {
          onEventTextChange(JSON.stringify(EVENT_TEMPLATES[name], null, 2))
          changeScript('')
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
          changeScript(saved.assertionScript ?? '')
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
            extensions={extensions}
            onChange={onEventTextChange} />
        )}
      </div>
      <div
        role="separator" aria-orientation="horizontal" aria-label="Resize the assertion script panel"
        tabIndex={0}
        className="relative flex h-px shrink-0 cursor-row-resize touch-none items-center justify-center bg-border after:absolute after:inset-x-0 after:-top-1.5 after:-bottom-1.5 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
        onPointerDown={startResizingScriptPanel}
      >
        <div className="z-10 flex h-3 w-4 items-center justify-center rounded-xs border bg-border">
          <GripHorizontal className="size-2.5" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 p-1.5" style={{ height: scriptPanelHeight }}>
        <div className="cm-host h-full min-w-0 flex-1 overflow-auto rounded-md border font-mono text-sm">
          {mounted && (
            <CodeMirror value={scriptDraft} height="100%" theme={theme}
              extensions={SCRIPT_EDITOR_EXTENSIONS}
              placeholder="expect(response.statusCode).toBe(200)"
              onChange={changeScript} />
          )}
        </div>
        <Button size="sm" disabled={!scriptDraft.trim() || !hasResult}
          onClick={() => onRunChecks(scriptDraft)}>
          <ListChecks className="size-3.5" /> Run checks
        </Button>
      </div>
      <Dialog open={saveOpen} onOpenChange={(o) => {
        setSaveOpen(o)
        if (!o) setSaveName('')
      }}>
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
