import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

// A click-to-copy value. Each instance owns its copied state, so copying one
// credential doesn't flash the checkmark on its neighbours.
export function CopyableValue({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this a copy landing just before unmount sets state on a dead
  // component (and keeps a timer alive for no one).
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      // Denied permission, or a non-secure context: say so rather than
      // showing a checkmark for a copy that never happened.
      toast.error('Could not copy to clipboard')
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={`Copy ${value}`}
      className={className ??
        'group inline-flex items-center gap-1 font-mono text-xs text-foreground/90 hover:text-foreground'}>
      {value}
      {copied
        ? <Check className="size-3 text-emerald-500" />
        : <Copy className="size-3 opacity-40 group-hover:opacity-100" />}
    </button>
  )
}
