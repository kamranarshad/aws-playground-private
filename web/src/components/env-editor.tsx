import { useState } from 'react'
import { ChevronsUpDown, Plus } from 'lucide-react'
import { EnvFilePicker } from '@/components/env-file-picker'
import { EnvVarRow, type EnvRow } from '@/components/env-var-row'
import { LocalServiceToggles } from '@/components/local-service-toggles'
import { Button } from '@/components/ui/button'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function EnvEditor({ fn }: { fn: FunctionDef }) {
  const [rows, setRows] = useState<EnvRow[]>(() =>
    Object.entries(fn.env).map(([key, value]) => ({ key, value }))
  )
  const update = useUpdateFunction()

  // Rows are edited freely and persisted on blur: a key is allowed to be
  // empty or half-typed while you work, and only usable ones get saved.
  function save(next: EnvRow[]) {
    setRows(next)
    const env: Record<string, string> = {}
    for (const r of next) if (r.key.trim()) env[r.key.trim()] = r.value
    update.mutate({ id: fn.id, patch: { env } })
  }

  function setRow(i: number, patch: Partial<EnvRow>) {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  return (
    <Collapsible defaultOpen={rows.length > 0} className="border-b px-4 py-2">
      <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <CollapsibleTrigger className="flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Environment variables ({rows.length}) <ChevronsUpDown className="size-3" />
        </CollapsibleTrigger>
        <div className="flex items-center gap-2">
          <LocalServiceToggles fn={fn} />
          <EnvFilePicker fn={fn} />
        </div>
      </div>
      <CollapsibleContent className="pt-2">
        <div className="grid gap-1.5">
          {rows.map((row, i) => (
            <EnvVarRow
              key={i}
              row={row}
              onChange={(patch) => setRow(i, patch)}
              onCommit={() => save(rows)}
              onRemove={() => save(rows.filter((_, j) => j !== i))}
            />
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
