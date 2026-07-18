import { useState } from 'react'
import { ArrowLeft, Download, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useClearHistory, useHistoryQuery } from '@/lib/queries'
import type { HistoryEntry } from '@/lib/types'

function age(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function HistoryList({ fnId, onLoadEvent }: {
  fnId: string
  onLoadEvent: (eventText: string) => void
}) {
  const { data: entries = [] } = useHistoryQuery(fnId)
  const clear = useClearHistory()
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null)

  if (openEntry) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setOpenEntry(null)}>
            <ArrowLeft className="size-3.5" /> Back
          </Button>
          <Badge variant={openEntry.ok ? 'secondary' : 'destructive'} className="text-[10px]">
            {openEntry.ok ? 'OK' : openEntry.error?.type ?? 'ERROR'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {age(openEntry.ts)} · {openEntry.durationMs ?? '?'}ms
            {openEntry.truncated ? ' · truncated' : ''}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto"
            onClick={() => onLoadEvent(JSON.stringify(openEntry.event, null, 2))}>
            <Download className="size-3.5" /> Load event
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">
            {`EVENT\n${JSON.stringify(openEntry.event, null, 2)}\n\n` +
              (openEntry.ok
                ? `RESPONSE\n${JSON.stringify(openEntry.response, null, 2)}`
                : `ERROR\n${openEntry.error?.type}: ${openEntry.error?.message}`) +
              `\n\nLOGS\n${openEntry.logs || '(none)'}`}
          </pre>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-xs text-muted-foreground">{entries.length} runs (max 50 kept)</span>
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
                <Badge variant={e.ok ? 'secondary' : 'destructive'} className="text-[10px]">
                  {e.ok ? 'OK' : 'ERR'}
                </Badge>
                <span className="font-mono">{e.handler}</span>
                <span className="ml-auto text-muted-foreground">
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
    </div>
  )
}
