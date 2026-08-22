import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { FunctionDef, Runtime } from '@/lib/types'

// Fixed order rather than discovery order, so the chip row doesn't reorder
// itself as functions are added or removed.
const RUNTIME_ORDER: Runtime[] = ['python', 'node', 'java', 'provided']

// Chips rather than a dropdown, so the active language is visible at a
// glance instead of hidden behind a click.
function LanguageFilter({ runtimes, active, onToggle }: {
  runtimes: Runtime[]
  active: ReadonlySet<Runtime>
  onToggle: (runtime: Runtime) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {runtimes.map((runtime) => (
        <button
          key={runtime}
          type="button"
          aria-pressed={active.has(runtime)}
          onClick={() => onToggle(runtime)}
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-muted/60',
            active.has(runtime) ? 'text-foreground' : 'text-muted-foreground/30',
          )}
        >
          {runtime}
        </button>
      ))}
    </div>
  )
}

export function AppSidebar({ functions, selectedId, onSelect, onAdd }: {
  functions: FunctionDef[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const [query, setQuery] = useState('')
  // null = every present language; a specific runtime = solo'd to just that
  // one. Not an excluded set: "all" has to track `presentRuntimes` live (a
  // language that only just showed up must appear when nothing is solo'd),
  // which a snapshot of what's excluded can't do on its own.
  const [soloRuntime, setSoloRuntime] = useState<Runtime | null>(null)

  const presentRuntimes = useMemo(
    () => RUNTIME_ORDER.filter((r) => functions.some((fn) => fn.runtime === r)),
    [functions],
  )
  const activeRuntimes = useMemo(
    () => new Set(soloRuntime ? [soloRuntime] : presentRuntimes),
    [soloRuntime, presentRuntimes],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return functions.filter((fn) =>
      (!needle || fn.name.toLowerCase().includes(needle)) && activeRuntimes.has(fn.runtime))
  }, [functions, query, activeRuntimes])

  // Solo, not multi-toggle: clicking a language isolates it, so one click
  // gets you to "just this language" instead of clicking off the others.
  // Clicking the already-solo'd language is the way back to seeing everything.
  function toggleRuntime(runtime: Runtime) {
    setSoloRuntime((prev) => (prev === runtime ? null : runtime))
  }

  function clearFilters() {
    setQuery('')
    setSoloRuntime(null)
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Functions
        </span>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus className="size-4" /> Add
        </Button>
      </div>
      {functions.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b px-3 pb-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search functions…"
              className="h-7 pl-7 font-mono text-xs"
            />
          </div>
          <LanguageFilter runtimes={presentRuntimes} active={activeRuntimes} onToggle={toggleRuntime} />
        </div>
      )}
      <ScrollArea className="flex-1">
        <ul className="px-2 pb-2">
          {filtered.map((fn) => (
            <li key={fn.id}>
              <button
                onClick={() => onSelect(fn.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-none border px-2.5 py-1.5 text-left text-sm transition-colors',
                  fn.id === selectedId
                    ? 'corner-frame hatch-active border-brand/50 bg-brand/5 font-medium text-foreground'
                    : 'border-transparent text-foreground hover:bg-accent',
                )}
              >
                <span className="truncate">{fn.name}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 font-mono text-[10px]',
                    fn.id === selectedId && 'border-brand/40 text-brand',
                  )}
                >
                  {fn.runtime}
                </Badge>
              </button>
            </li>
          ))}
          {functions.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              No functions yet.
            </li>
          )}
          {functions.length > 0 && filtered.length === 0 && (
            <li className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm text-muted-foreground">
              No functions match.
              <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>Clear</Button>
            </li>
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}
