import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

// The check/copy toggle shared by every click-to-copy affordance. `className`
// applies to both states (sizing); `idleClassName` is extra styling for the
// not-yet-copied Copy icon only, since a couple of callers dim it until hover
// but want the confirmation checkmark fully visible.
export function CopyIcon({ copied, className, idleClassName }: {
  copied: boolean
  className?: string
  idleClassName?: string
}) {
  return copied
    ? <Check className={cn('text-success', className)} />
    : <Copy className={cn(className, idleClassName)} />
}
