import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronsUpDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

type Row = { key: string; value: string }

export function EnvEditor({ fn }: { fn: FunctionDef }) {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(fn.env).map(([key, value]) => ({ key, value }))
  )
  const update = useUpdateFunction()
  const { data: envFiles = [] } = useQuery({
    queryKey: ['envfiles', fn.path],
    queryFn: () => api.detect(fn.path),
    select: (d) => d.envFiles ?? [],
  })
  const envFile = fn.envFile ?? 'auto'
  const hasDotEnv = envFiles.includes('.env')

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
      <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <CollapsibleTrigger className="flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Environment variables ({rows.length}) <ChevronsUpDown className="size-3" />
        </CollapsibleTrigger>
        <Select value={envFile}
          onValueChange={(v) => update.mutate({ id: fn.id, patch: { envFile: v } })}>
          <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label="Env file">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              {hasDotEnv ? 'Auto (.env)' : 'Auto (no .env)'}
            </SelectItem>
            <SelectItem value="none">None</SelectItem>
            {(envFiles.includes(envFile) || envFile === 'auto' || envFile === 'none'
              ? envFiles
              : [...envFiles, envFile]
            ).map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
