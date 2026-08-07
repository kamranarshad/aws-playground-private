import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { FunctionDef } from '@/lib/types'

export function AppSidebar({ functions, selectedId, onSelect, onAdd }: {
  functions: FunctionDef[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}) {
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
      <ScrollArea className="flex-1">
        <ul className="px-2 pb-2">
          {functions.map((fn) => (
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
        </ul>
      </ScrollArea>
    </aside>
  )
}
