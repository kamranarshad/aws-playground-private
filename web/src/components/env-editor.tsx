import { useEffect, useState } from 'react'
import { ChevronsUpDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

type Row = { key: string; value: string }

export function EnvEditor({ fn }: { fn: FunctionDef }) {
  const [rows, setRows] = useState<Row[]>([])
  const update = useUpdateFunction()

  useEffect(() => {
    setRows(Object.entries(fn.env).map(([key, value]) => ({ key, value })))
  }, [fn.id, fn.env])

  function save(next: Row[]) {
    setRows(next)
    const env: Record<string, string> = {}
    for (const r of next) if (r.key.trim()) env[r.key.trim()] = r.value
    update.mutate({ id: fn.id, patch: { env } })
  }

  function setRow(i: number, patch: Partial<Row>) {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
    setRows(next)
  }

  return (
    <Collapsible defaultOpen={rows.length > 0} className="border-b px-4 py-2">
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Environment variables ({rows.length}) <ChevronsUpDown className="size-3" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="grid gap-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input className="h-8 font-mono text-xs" placeholder="KEY" value={row.key}
                spellCheck={false} onChange={(e) => setRow(i, { key: e.target.value })}
                onBlur={() => save(rows)} />
              <Input className="h-8 font-mono text-xs" placeholder="value" value={row.value}
                spellCheck={false} onChange={(e) => setRow(i, { value: e.target.value })}
                onBlur={() => save(rows)} />
              <Button variant="ghost" size="icon" className="size-8 shrink-0"
                aria-label="Remove variable"
                onClick={() => save(rows.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-1.5"
          onClick={() => setRows([...rows, { key: '', value: '' }])}>
          <Plus className="size-3.5" /> Add variable
        </Button>
      </CollapsibleContent>
    </Collapsible>
  )
}
