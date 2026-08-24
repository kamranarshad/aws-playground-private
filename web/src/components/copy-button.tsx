import { Button } from '@/components/ui/button'
import { CopyIcon } from '@/components/copy-icon'
import { useCopy } from '@/lib/use-copy'
import { cn } from '@/lib/utils'

// Icon-only copy affordance for values too big to render as their own label
// (a whole JSON payload). For short inline values use CopyableValue instead.
export function CopyButton({ value, label, className }: {
  value: string
  label: string
  className?: string
}) {
  const { copied, copy } = useCopy()

  return (
    <Button
      type="button" variant="ghost" size="icon-sm" aria-label={label}
      onClick={() => copy(value)}
      className={cn('text-muted-foreground hover:text-foreground', className)}
    >
      <CopyIcon copied={copied} className="size-3.5" />
    </Button>
  )
}
