import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { ServiceRow } from '@/components/service-row'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useServices } from '@/lib/queries'

export const Route = createFileRoute('/services')({
  component: ServicesPage,
})

function ServicesPage() {
  const qc = useQueryClient()
  const { data, error } = useServices()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkPending, setBulkPending] = useState(false)
  const q = query.trim().toLowerCase()

  const services = data?.services ?? []
  const filtered = q
    ? services.filter((s) =>
        [s.label, s.shortLabel, s.name].some((v) => v.toLowerCase().includes(q)))
    : services

  // Only not-yet-running rows can be bulk-started; keep the selection scoped
  // to what's currently visible so narrowing the search never leaves ghosts.
  const startableNames = filtered.filter((s) => s.state !== 'running').map((s) => s.name)
  const selectedNames = startableNames.filter((n) => selected.has(n))
  const selectedCount = selectedNames.length
  const allSelected = startableNames.length > 0 && selectedCount === startableNames.length
  const headerState = allSelected ? true : selectedCount > 0 ? 'indeterminate' : false

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(startableNames))
  }

  function toggleOne(name: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(name)
      else next.delete(name)
      return next
    })
  }

  async function startSelected() {
    if (selectedNames.length === 0) return
    setBulkPending(true)
    try {
      // Fire the existing per-service start endpoint for each, in parallel —
      // no new backend. Refetch once so every started row flips together.
      await Promise.all(selectedNames.map((name) => api.startService(name)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start services')
    } finally {
      setBulkPending(false)
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['services'] })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2">
        <h1 className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-foreground">
          Local services
        </h1>
        <div className="relative w-64 max-w-[55vw]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services"
            aria-label="Search services"
            className="h-8 pl-8"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <p className="text-xs text-destructive">
            Could not query local services: {error.message}. If the playground
            server was updated, restart it and reload this page.
          </p>
        ) : !data ? (
          <p className="text-xs text-muted-foreground">Checking docker…</p>
        ) : !data.docker.available ? (
          <div className="max-w-md rounded-lg border bg-card p-4">
            <p className="text-sm font-medium">Docker is not available</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Install or start Docker to run local AWS-equivalent services like
              MinIO, ElasticMQ, DynamoDB Local, Redis, and Postgres. Docker is
              never touched unless you start a service here.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {q ? `No services match “${query}”.` : 'No local services registered.'}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center gap-3 border-b bg-surface-strip/50 px-3 py-2">
              <Checkbox
                checked={headerState}
                disabled={startableNames.length === 0}
                onCheckedChange={toggleAll}
                aria-label="Select all startable services"
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {selectedCount > 0 ? `${selectedCount} selected` : `${filtered.length} services`}
              </span>
              {selectedCount > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" onClick={startSelected} disabled={bulkPending}>
                    {bulkPending && <Loader2 className="size-3.5 animate-spin" />}
                    Start selected ({selectedCount})
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              )}
            </div>
            <ul className="divide-y">
              {filtered.map((svc) => (
                <ServiceRow
                  key={svc.name}
                  svc={svc}
                  selectable={svc.state !== 'running'}
                  selected={selected.has(svc.name)}
                  onSelectedChange={(checked) => toggleOne(svc.name, checked)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
