import { useMemo, type ReactNode } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import { TraceTab, type TraceView } from '@/components/trace-tab'
import type { AssertionRun } from '@/lib/assertions'
import { cn } from '@/lib/utils'
import type { InvokeResult, ResultTab } from '@/lib/types'

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

function ChecksSummaryBadge({ run }: { run: AssertionRun }) {
  const total = run.results.length
  const passed = run.results.filter((r) => r.pass).length
  // != null, not truthiness: a script that threw an empty-message Error still
  // errored, and reading it as "no error" turns a broken run into a calm chip.
  const errored = run.scriptError != null
  if (total === 0 && !errored) {
    return (
      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
        no assertions
      </Badge>
    )
  }
  const allPass = !errored && passed === total
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono tabular-nums text-[10px]',
        allPass ? 'border-transparent bg-success/15 text-success'
          : 'border-transparent bg-destructive/15 text-destructive',
      )}
    >
      {/* A script that threw before its first expect() has nothing to count,
          and "0/0 passed" reads like a no-op rather than a failure. */}
      {total === 0 && errored ? 'script error' : `${passed}/${total} passed`}
    </Badge>
  )
}

function ChecksList({ run }: { run: AssertionRun }) {
  if (run.results.length === 0 && run.scriptError == null) {
    return <Pane>Script had no assertions.</Pane>
  }
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y font-mono text-xs">
        {run.results.map((r, i) => (
          <li key={i} className="flex items-start gap-2 px-3 py-1.5">
            {r.pass
              ? <CircleCheck role="img" aria-label="Check passed" className="mt-0.5 size-3.5 shrink-0 text-success" />
              : <CircleX role="img" aria-label="Check failed" className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
            <span>{r.matcher}({JSON.stringify(r.expected)}) — actual: {JSON.stringify(r.actual)}</span>
          </li>
        ))}
        {run.scriptError != null && (
          <li className="flex items-start gap-2 px-3 py-1.5">
            <CircleX role="img" aria-label="Script error" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="text-destructive">{run.scriptError}</span>
          </li>
        )}
      </ul>
    </ScrollArea>
  )
}

export function ResultPanel({
  result, checkResults, historyTab, activeTab, onActiveTabChange, traceView, onTraceViewChange,
}: {
  result: InvokeResult | null
  checkResults?: AssertionRun | null
  historyTab?: ReactNode
  activeTab: ResultTab
  onActiveTabChange: (tab: ResultTab) => void
  traceView: TraceView
  onTraceViewChange: (view: TraceView) => void
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

  // Tabs is controlled because the Checks tab only exists while there are
  // check results: the next invoke (or a function switch) unmounts it, and
  // Radix would keep "checks" selected against a trigger and content that are
  // both gone — rendering an entirely blank panel until the user clicks a tab.
  return (
    <Tabs
      value={activeTab === 'checks' && checkResults == null ? 'response' : activeTab}
      onValueChange={(v) => onActiveTabChange(v as ResultTab)}
      className="flex h-full flex-col gap-0"
    >
      <div className="m-1.5 flex items-center gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <TabsList className="h-8 bg-transparent">
          <TabsTrigger value="response" className={TAB}>Response</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}>Logs</TabsTrigger>
          <TabsTrigger value="report" className={TAB}>Report</TabsTrigger>
          <TabsTrigger value="trace" className={TAB}>Trace</TabsTrigger>
          {checkResults != null && <TabsTrigger value="checks" className={TAB}>Checks</TabsTrigger>}
          {historyTab && <TabsTrigger value="history" className={TAB}>History</TabsTrigger>}
        </TabsList>
        {result && (
          <div className="ml-auto flex items-center gap-1.5">
            {result.ok && <HttpStatusBadge response={result.response} />}
            {checkResults != null && <ChecksSummaryBadge run={checkResults} />}
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
              (result.report.initMs != null ? `Init Duration: ${result.report.initMs} ms\n` : '') +
              (result.report.buildMs != null ? `Build Duration: ${result.report.buildMs} ms\n` : '') +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
        </Pane>
      </TabsContent>
      <TabsContent value="trace" className="min-h-0 flex-1">
        <TraceTab
          key={result?.report.requestId ?? 'empty'}
          spans={result?.trace?.spans ?? []}
          error={result?.trace?.error}
          view={traceView}
          onViewChange={onTraceViewChange}
        />
      </TabsContent>
      {checkResults != null && (
        <TabsContent value="checks" className="min-h-0 flex-1">
          <ChecksList run={checkResults} />
        </TabsContent>
      )}
      {historyTab && (
        <TabsContent value="history" className="min-h-0 flex-1">
          {historyTab}
        </TabsContent>
      )}
    </Tabs>
  )
}
