import { useEffect, useState } from 'react'
import { Moon, Play, Plus, Zap } from 'lucide-react'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { useTheme } from '@/lib/theme'
import type { FunctionDef } from '@/lib/types'

export function CommandPalette({ functions, canInvoke, onSelect, onAdd, onInvoke }: {
  functions: FunctionDef[]
  canInvoke: boolean
  onSelect: (id: string) => void
  onAdd: () => void
  onInvoke: () => void
}) {
  const [open, setOpen] = useState(false)
  const { toggle } = useTheme()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function run(fn: () => void) {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or function name…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem disabled={!canInvoke} onSelect={() => run(onInvoke)}>
            <Play className="size-4" /> Invoke current function
          </CommandItem>
          <CommandItem onSelect={() => run(onAdd)}>
            <Plus className="size-4" /> Add function
          </CommandItem>
          <CommandItem onSelect={() => run(toggle)}>
            <Moon className="size-4" /> Toggle theme
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Functions">
          {functions.map((fn) => (
            <CommandItem key={fn.id} onSelect={() => run(() => onSelect(fn.id))}>
              <Zap className="size-4" /> {fn.name}
              <span className="ml-auto text-xs text-muted-foreground">{fn.runtime}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
