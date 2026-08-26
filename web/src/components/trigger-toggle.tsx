import { useEffect, useRef, useState } from 'react'
import { Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDetect, useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

const FLASH_OFF_MS = 2000

// Turns an already-configured trigger on/off, independent of TriggerButton's
// picker (which only sets type/queue name). Renders nothing until a trigger
// type is actually configured there, and nothing when a playground.json
// declaration governs the trigger instead — there's no on/off state to flip
// in that case, it's always "on" per the file, same reasoning TriggerButton
// itself uses to fall back to a read-only label.
export function TriggerToggle({ fn }: { fn: FunctionDef }) {
  const { data: projectTrigger } = useDetect(fn.path, (d) => d.projectTrigger ?? null)
  const update = useUpdateFunction()
  const [flashOff, setFlashOff] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this a toggle landing just before unmount keeps a timer alive
  // for no one.
  useEffect(() => () => clearTimeout(timer.current), [])

  if (projectTrigger != null || !fn.trigger) return null

  const trigger = fn.trigger
  const enabled = trigger.enabled

  function toggle() {
    const next = !enabled
    clearTimeout(timer.current)
    if (next) {
      setFlashOff(false)
    } else {
      setFlashOff(true)
      timer.current = setTimeout(() => setFlashOff(false), FLASH_OFF_MS)
    }
    update.mutate({ id: fn.id, patch: { trigger: { ...trigger, enabled: next } } })
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle}
      aria-label={enabled ? 'Disable trigger' : 'Enable trigger'}
      title={enabled ? 'Disable trigger' : 'Enable trigger'}>
      <Power className={cn('size-4', flashOff ? 'text-destructive' : enabled ? 'text-success' : undefined)} />
    </Button>
  )
}
