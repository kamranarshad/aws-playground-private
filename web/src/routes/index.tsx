import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { AddFunctionDialog } from '@/components/add-function-dialog'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { EnvEditor } from '@/components/env-editor'
import { EventPanel } from '@/components/event-panel'
import { FunctionHeader } from '@/components/function-header'
import { HealthChips } from '@/components/health-chips'
import { HistoryList } from '@/components/history-list'
import { ResultPanel } from '@/components/result-panel'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useFunctions, useInvoke } from '@/lib/queries'
import type { InvokeResult } from '@/lib/types'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const { data: functions = [] } = useFunctions()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [result, setResult] = useState<InvokeResult | null>(null)
  const invoke = useInvoke()

  useEffect(() => {
    if (selectedId && !functions.some((f) => f.id === selectedId)) setSelectedId(null)
    if (!selectedId && functions.length > 0) setSelectedId(functions[0].id)
  }, [functions, selectedId])

  const selected = functions.find((f) => f.id === selectedId) ?? null

  function runInvoke(functionId: string) {
    let event: unknown
    try {
      event = JSON.parse(drafts[functionId] ?? '{}')
    } catch {
      toast.error('Event is not valid JSON')
      return
    }
    invoke.mutate({ functionId, event }, { onSuccess: setResult })
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selectedId) {
        e.preventDefault()
        runInvoke(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => setResult(null), [selectedId])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="flex items-baseline gap-1.5 text-sm font-semibold">
          <span className="font-mono text-base leading-none text-brand">λ</span>
          Lambda Playground
        </h1>
        <div className="flex items-center gap-3">
          <HealthChips />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">⌘K</kbd>
          <ThemeToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <AppSidebar functions={functions} selectedId={selectedId}
          onSelect={setSelectedId} onAdd={() => setAddOpen(true)} />
        <main className="min-w-0 flex-1">
          {selected ? (
            <div className="flex h-full flex-col">
              <FunctionHeader fn={selected} onDeleted={() => setSelectedId(null)} />
              <EnvEditor key={selected.id} fn={selected} />
              <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                <ResizablePanel defaultSize={50} minSize={25}>
                  <EventPanel
                    fn={selected}
                    eventText={drafts[selected.id] ?? '{}'}
                    onEventTextChange={(text) =>
                      setDrafts((d) => ({ ...d, [selected.id]: text }))}
                    onInvoke={() => runInvoke(selected.id)}
                    invoking={invoke.isPending}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={50} minSize={25}>
                  <ResultPanel
                    result={result}
                    historyTab={
                      <HistoryList
                        key={selected.id}
                        fnId={selected.id}
                        onLoadEvent={(text) =>
                          setDrafts((d) => ({ ...d, [selected.id]: text }))}
                      />
                    }
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <span className="font-mono text-5xl leading-none text-brand/80">λ</span>
              <div className="space-y-1">
                <p className="text-sm font-medium">No functions yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Register a Lambda handler to run it locally — no deploy, no Docker.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Add one from the sidebar, or press{' '}
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>.
              </p>
            </div>
          )}
        </main>
      </div>
      <AddFunctionDialog open={addOpen} onOpenChange={setAddOpen} onCreated={setSelectedId} />
      <CommandPalette
        functions={functions}
        canInvoke={!!selectedId}
        onSelect={setSelectedId}
        onAdd={() => setAddOpen(true)}
        onInvoke={() => selectedId && runInvoke(selectedId)}
      />
    </div>
  )
}
