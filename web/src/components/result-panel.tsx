import { useMemo, type ReactNode } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import { httpStatusOf } from '@/lib/http'
import { cn } from '@/lib/utils'
import type { InvokeResult } from '@/lib/types'

// Reference look: the active tab is orange text on a flat background — no
// pill, no shadow — so all state lives in the text color. Both light and dark
// modes use orange text; shadows are suppressed at the specific selector depth.
const TAB =
  'text-xs data-[state=active]:bg-transparent data-[state=active]:text-brand group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-brand'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">{children}</pre>
    </ScrollArea>
  )
}

export function ResultPanel({ result, expectedStatus, historyTab }: {
  result: InvokeResult | null
  expectedStatus?: number
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
          <TabsTrigger value="response" className={TAB}>Response</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}>Logs</TabsTrigger>
          <TabsTrigger value="report" className={TAB}>Report</TabsTrigger>
          {historyTab && <TabsTrigger value="history" className={TAB}>History</TabsTrigger>}
        </TabsList>
        {result && (
          <div className="ml-auto flex items-center gap-1.5">
            {result.ok && <HttpStatusBadge response={result.response} />}
            {expectedStatus != null && (() => {
              const actualStatus = result.ok ? httpStatusOf(result.response) : null
              const pass = actualStatus === expectedStatus
              return (
                <Badge
                  variant="outline"
                  className={cn(
                    'gap-1 font-mono text-[10px]',
                    pass ? 'border-transparent bg-success/15 text-success'
                      : 'border-transparent bg-destructive/15 text-destructive',
                  )}
                >
                  {pass
                    ? <CircleCheck role="img" aria-label="Assertion passed" className="size-3" />
                    : <CircleX role="img" aria-label="Assertion failed" className="size-3" />}
                  Expected {expectedStatus}
                  {!pass && ` · got ${actualStatus ?? 'no status'}`}
                </Badge>
              )
            })()}
            <Badge
              variant={result.ok ? 'outline' : 'destructive'}
              className={cn(
                'font-mono tabular-nums text-[10px]',
                result.ok && 'border-transparent bg-success/15 text-success',
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
        {/* Re-keyed per invoke, like the response tree: rows are keyed by
            index, so without this an expanded structured entry would stay
            expanded over whatever landed at that index in the next run. */}
        <LogViewer key={result?.report.requestId ?? 'empty'} raw={result?.logs} />
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
