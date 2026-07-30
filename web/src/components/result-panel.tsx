import { useMemo, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import { cn } from '@/lib/utils'
import type { InvokeResult } from '@/lib/types'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">{children}</pre>
    </ScrollArea>
  )
}

export function ResultPanel({ result, historyTab }: {
  result: InvokeResult | null
  historyTab?: ReactNode
}) {
  // Minified: the copy is a handoff to curl, an editor, or a test fixture, and
  // the tree already covers reading it here. Memoised because a response can be
  // large and only the copy button needs the flat text.
  const responseJson = useMemo(() => {
    if (!result?.ok) return null
    // A handler that returned nothing has no JSON to copy: stringify(undefined)
    // hands back undefined, not a string.
    const json: string | undefined = JSON.stringify(result.response)
    return json ?? null
  }, [result])

  return (
    <Tabs defaultValue="response" className="flex h-full flex-col gap-0">
      <div className="m-1.5 flex items-center gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <TabsList className="h-8 bg-transparent">
          <TabsTrigger value="response" className="text-xs">Response</TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
          <TabsTrigger value="report" className="text-xs">Report</TabsTrigger>
          {historyTab && <TabsTrigger value="history" className="text-xs">History</TabsTrigger>}
        </TabsList>
        {result && (
          <div className="ml-auto flex items-center gap-1.5">
            {result.ok && <HttpStatusBadge response={result.response} />}
            <Badge
              variant={result.ok ? 'outline' : 'destructive'}
              className={cn(
                'font-mono tabular-nums text-[10px]',
                result.ok && 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
              )}
            >
              {result.ok ? 'OK' : result.error?.type ?? 'ERROR'}
              {' · '}{result.report.durationMs}ms
            </Badge>
          </div>
        )}
      </div>
      <TabsContent value="response" className="relative min-h-0 flex-1">
        {result?.ok
          ? (
            <>
              {responseJson != null && (
                <CopyButton
                  value={responseJson} label="Copy response JSON"
                  // Opaque, so rows scrolling under it stay legible.
                  className="absolute top-1.5 right-3 z-10 bg-background"
                />
              )}
              <ScrollArea className="h-full">
                {/* Re-keyed per invoke so the next response opens at its default
                    depth instead of inheriting the last one's expanded rows. */}
                <JsonTree key={result.report.requestId} value={result.response} className="pr-10" />
              </ScrollArea>
            </>
          )
          : (
            <Pane>
              {!result
                ? 'Invoke to see the response.'
                : `${result.error?.type}: ${result.error?.message}\n\n${(result.error?.stackTrace ?? []).join('\n')}`}
            </Pane>
          )}
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 flex-1">
        <LogViewer raw={result?.logs} />
      </TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1">
        <Pane>
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
              (result.report.buildMs != null ? `Build Duration: ${result.report.buildMs} ms\n` : '') +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
        </Pane>
      </TabsContent>
      {historyTab && (
        <TabsContent value="history" className="min-h-0 flex-1">
          {historyTab}
        </TabsContent>
      )}
    </Tabs>
  )
}
