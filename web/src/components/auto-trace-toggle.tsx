import { useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

// Node-only opt-in for OpenTelemetry auto-instrumentation (HTTP, AWS SDK,
// common DB drivers) with zero code changes to the handler -- hidden for
// other runtimes since the underlying mechanism (a Node --require flag)
// doesn't generalize to them. A handler with its own tracing setup wins
// regardless of this toggle (server/auto-trace-detect.js decides that per
// invoke), so turning this on is always safe to try.
export function AutoTraceToggle({ fn }: { fn: FunctionDef }) {
  const update = useUpdateFunction()
  if (fn.runtime !== 'node') return null
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
      title="Auto-instrument common libraries (HTTP, AWS SDK, DB drivers) with zero code changes -- skipped if the handler already sets up its own tracing"
    >
      <input
        type="checkbox"
        className="accent-primary"
        checked={fn.autoTrace}
        onChange={(e) => update.mutate({ id: fn.id, patch: { autoTrace: e.target.checked } })}
      />
      Auto-trace
    </label>
  )
}
