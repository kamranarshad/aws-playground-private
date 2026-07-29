import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

const CONFIRM_MS = 1200

// Clipboard writes with a short-lived confirmation. Each caller owns its own
// `copied` state, so copying one value doesn't flash the checkmark on its
// neighbours.
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this a copy landing just before unmount sets state on a dead
  // component (and keeps a timer alive for no one).
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS)
    } catch {
      // Denied permission, or a non-secure context: say so rather than
      // showing a checkmark for a copy that never happened.
      toast.error('Could not copy to clipboard')
    }
  }

  return { copied, copy }
}
