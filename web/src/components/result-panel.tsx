import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { InvokeResult } from '@/lib/types'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">{children}</pre>
    </ScrollArea>
  )
}

export function ResultPanel({ result, historyTab }: {
  result: InvokeResult | null
  historyTab?: ReactNode
}) {
  return (
    <Tabs defaultValue="response" className="flex h-full flex-col gap-0">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <TabsList className="h-8">
          <TabsTrigger value="response" className="text-xs">Response</TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
          <TabsTrigger value="report" className="text-xs">Report</TabsTrigger>
          {historyTab && <TabsTrigger value="history" className="text-xs">History</TabsTrigger>}
        </TabsList>
        {result && (
          <Badge variant={result.ok ? 'secondary' : 'destructive'} className="ml-auto text-[10px]">
            {result.ok ? 'OK' : result.error?.type ?? 'ERROR'}
            {' · '}{result.report.durationMs}ms
          </Badge>
        )}
      </div>
      <TabsContent value="response" className="min-h-0 flex-1">
        <Pane>
          {!result
            ? 'Invoke to see the response.'
            : result.ok
              ? JSON.stringify(result.response, null, 2)
              : `${result.error?.type}: ${result.error?.message}\n\n${(result.error?.stackTrace ?? []).join('\n')}`}
        </Pane>
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 flex-1">
        <Pane>{result?.logs || 'No logs.'}</Pane>
      </TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1">
        <Pane>
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
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
