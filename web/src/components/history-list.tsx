import { useState } from 'react'
import { CircleCheck, CircleX, Download, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import { useClearHistory, useHistoryQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { HistoryEntry } from '@/lib/types'

const OK_CHIP = 'border-transparent bg-success/15 text-success'

function age(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function displayValue(value: unknown, truncated: boolean): string {
  if (truncated && typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

// A truncated field arrives as a raw JSON-string preview (see server/history.js),
// not the parsed value JsonTree expects — fall back to plain text for that case.
function JsonOrRaw({ value, truncated }: { value: unknown; truncated: boolean }) {
  if (truncated && typeof value === 'string') {
    return (
      <ScrollArea className="h-full">
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">{value}</pre>
      </ScrollArea>
    )
  }
  return (
    <ScrollArea className="h-full">
      <JsonTree value={value} />
    </ScrollArea>
  )
}

export function HistoryList({ fnId, onLoadEvent }: {
  fnId: string
  onLoadEvent: (eventText: string) => void
}) {
  const { data: entries = [] } = useHistoryQuery(fnId)
  const clear = useClearHistory()
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null)

  function loadEvent(entryToLoad: HistoryEntry) {
    onLoadEvent(displayValue(entryToLoad.event, entryToLoad.eventTruncated))
    setOpenEntry(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide tabular-nums text-muted-foreground">{entries.length} runs (max 50 kept)</span>
        <Button variant="ghost" size="sm" disabled={entries.length === 0}
          onClick={() => clear.mutate(fnId)}>
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul>
          {entries.map((e) => (
            <li key={e.id}>
              <button
                className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => setOpenEntry(e)}
              >
                {e.ok
                  ? <CircleCheck role="img" aria-label="OK" className="size-3.5 shrink-0 text-success" />
                  : <CircleX role="img" aria-label="Error" className="size-3.5 shrink-0 text-destructive" />}
                {e.ok && <HttpStatusBadge response={e.response} prefix={false} />}
                {e.source?.type === 'trigger' && (
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px]">trigger</Badge>
                )}
                <span className="truncate font-mono">{e.handler}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {e.durationMs ?? '?'}ms · {age(e.ts)}
                </span>
              </button>
            </li>
          ))}
          {entries.length === 0 && (
            <li className="p-4 text-center text-xs text-muted-foreground">
              No runs yet. Invoke to record history.
            </li>
          )}
        </ul>
      </ScrollArea>

      <Dialog open={openEntry !== null} onOpenChange={(open) => { if (!open) setOpenEntry(null) }}>
        {openEntry && (
          <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
            <DialogHeader className="sr-only">
              <DialogTitle>{openEntry.handler} invoke details</DialogTitle>
            </DialogHeader>
            <Tabs defaultValue="response" className="flex min-h-0 flex-1 flex-col gap-0">
              <div className="flex items-center gap-2 border-b px-4 py-2 pr-10">
                <TabsList className="h-8">
                  <TabsTrigger value="request">Request</TabsTrigger>
                  <TabsTrigger value="response">Response</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                </TabsList>
                <Badge variant={openEntry.ok ? 'outline' : 'destructive'}
                  className={cn('font-mono text-[10px]', openEntry.ok && OK_CHIP)}>
                  {openEntry.ok ? 'OK' : openEntry.error?.type ?? 'ERROR'}
                </Badge>
                {openEntry.ok && <HttpStatusBadge response={openEntry.response} />}
                {openEntry.source?.type === 'trigger' && (
                  <Badge variant="outline" className="font-mono text-[10px]">trigger</Badge>
                )}
                <span className="font-mono text-xs uppercase tracking-wide tabular-nums text-muted-foreground">
                  {age(openEntry.ts)} · {openEntry.durationMs ?? '?'}ms
                  {openEntry.truncated ? ' · truncated' : ''}
                </span>
                <Button variant="ghost" size="sm" className="ml-auto"
                  onClick={() => loadEvent(openEntry)}>
                  <Download className="size-3.5" /> Load event
                </Button>
              </div>
              <TabsContent value="request" className="min-h-0">
                <JsonOrRaw value={openEntry.event} truncated={openEntry.eventTruncated} />
              </TabsContent>
              <TabsContent value="response" className="min-h-0">
                {openEntry.ok
                  ? <JsonOrRaw value={openEntry.response} truncated={openEntry.responseTruncated} />
                  : (
                    <ScrollArea className="h-full">
                      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">
                        {`${openEntry.error?.type}: ${openEntry.error?.message}\n\n` +
                          (openEntry.error?.stackTrace ?? []).join('\n')}
                      </pre>
                    </ScrollArea>
                  )}
              </TabsContent>
              <TabsContent value="logs" className="min-h-0">
                <LogViewer raw={openEntry.logs} />
              </TabsContent>
            </Tabs>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
