import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AddFunctionDialog } from '@/components/add-function-dialog'
import { AppSidebar } from '@/components/app-sidebar'
import { HealthChips } from '@/components/health-chips'
import { ThemeToggle } from '@/components/theme-toggle'
import { useFunctions } from '@/lib/queries'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const { data: functions = [] } = useFunctions()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    if (selectedId && !functions.some((f) => f.id === selectedId)) setSelectedId(null)
    if (!selectedId && functions.length > 0) setSelectedId(functions[0].id)
  }, [functions, selectedId])

  const selected = functions.find((f) => f.id === selectedId) ?? null

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold">λ Lambda Playground</h1>
        <div className="flex items-center gap-3">
          <HealthChips />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <AppSidebar functions={functions} selectedId={selectedId}
          onSelect={setSelectedId} onAdd={() => setAddOpen(true)} />
        <main className="min-w-0 flex-1">
          {selected ? (
            <div className="p-4 text-sm text-muted-foreground">
              Workspace for {selected.name} (coming in the next tasks)
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Register a function to get started.
            </div>
          )}
        </main>
      </div>
      <AddFunctionDialog open={addOpen} onOpenChange={setAddOpen} onCreated={setSelectedId} />
    </div>
  )
}
