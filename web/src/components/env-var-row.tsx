import { Eye, EyeOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isSecretKey } from '@/lib/secrets'

// `revealed` is view state that rides along with the row so it follows the
// value when rows above it are removed. It is never persisted.
export type EnvRow = { key: string; value: string; revealed?: boolean }

export function EnvVarRow({ row, onChange, onCommit, onRemove }: {
  row: EnvRow
  onChange: (patch: Partial<EnvRow>) => void
  onCommit: () => void
  onRemove: () => void
}) {
  const secret = isSecretKey(row.key)
  return (
    <div className="flex items-center gap-1.5">
      <Input className="h-8 font-mono text-xs" placeholder="KEY" value={row.key}
        aria-label="Variable name" spellCheck={false}
        onChange={(e) => onChange({ key: e.target.value })} onBlur={onCommit} />
      <Input className="h-8 font-mono text-xs" placeholder="value" value={row.value}
        type={secret && !row.revealed ? 'password' : 'text'}
        aria-label={row.key ? `Value for ${row.key}` : 'Variable value'}
        spellCheck={false}
        onChange={(e) => onChange({ value: e.target.value })} onBlur={onCommit} />
      {secret && (
        <Button variant="ghost" size="icon" className="size-8 shrink-0"
          aria-label={`${row.revealed ? 'Hide' : 'Show'} value for ${row.key}`}
          onClick={() => onChange({ revealed: !row.revealed })}>
          {row.revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
      )}
      <Button variant="ghost" size="icon" className="size-8 shrink-0"
        aria-label="Remove variable" onClick={onRemove}>
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
