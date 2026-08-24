import { CopyIcon } from '@/components/copy-icon'
import { useCopy } from '@/lib/use-copy'

// A click-to-copy value that renders the value as its own label, for short
// inline strings like credentials. For payloads use CopyButton instead.
export function CopyableValue({ value, className }: { value: string; className?: string }) {
  const { copied, copy } = useCopy()

  return (
    <button type="button" onClick={() => copy(value)} aria-label={`Copy ${value}`}
      className={className ??
        'group inline-flex items-center gap-1 font-mono text-xs text-foreground/90 hover:text-foreground'}>
      {value}
      <CopyIcon copied={copied} className="size-3" idleClassName="opacity-40 group-hover:opacity-100" />
    </button>
  )
}
