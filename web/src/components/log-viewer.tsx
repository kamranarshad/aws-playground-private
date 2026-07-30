import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { parseLogs, type LogLevel } from '@/lib/log-lines'
import { cn } from '@/lib/utils'

// Light/dark pairs, matching the leaf colours in json-tree.tsx.
const LEVEL_TEXT: Record<LogLevel, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-sky-700 dark:text-sky-300',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
}

// The left edge bar is the tell that reads before any text does, so it wants
// a flat saturated colour rather than the text pair.
const LEVEL_BAR: Record<LogLevel, string> = {
  error: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
  debug: 'bg-muted-foreground/40',
  trace: 'bg-muted-foreground/40',
}

// Fixed cell widths rather than one grid spanning the list: a cross-row grid
// needs display:contents on the row wrappers, which drops the per-row hover,
// border, and error tint. The time is always the 12 characters of
// HH:mm:ss.SSS in a tabular face, so the columns line up regardless.
const TIME_CELL = 'w-[12ch] shrink-0 py-1 font-mono text-[11px] tabular-nums text-muted-foreground'
const LEVEL_CELL = 'w-12 shrink-0 py-1 text-[10px] font-semibold'

export function LogViewer({ raw }: { raw: string | undefined }) {
  const rows = useMemo(() => parseLogs(raw ?? ''), [raw])

  if (!rows.length) {
    return <p className="p-3 font-mono text-xs text-muted-foreground">No logs.</p>
  }

  return (
    <ScrollArea className="h-full">
      {rows.map((row, i) => (
        row.kind === 'divider'
          ? (
            <div key={i} className="flex items-center gap-2 bg-surface-strip px-3 py-1">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="font-mono text-[10px] tracking-wider text-muted-foreground">
                {row.label}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          )
          : (
            <div
              key={i}
              className={cn(
                'flex items-start gap-2 border-b border-border/40 pr-3 hover:bg-muted/40',
                row.level === 'error' && 'bg-red-500/5',
              )}
            >
              {/* self-stretch so the bar runs the full height of a folded trace. */}
              <span
                aria-hidden="true"
                className={cn('w-0.5 shrink-0 self-stretch',
                  row.level ? LEVEL_BAR[row.level] : 'bg-transparent')}
              />
              {/* Both cells keep their width when empty, so the message column
                  stays put down a list of mixed lines. */}
              <span className={TIME_CELL}>{row.time}</span>
              <span className={cn(LEVEL_CELL, row.level && LEVEL_TEXT[row.level])}>
                {row.level?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 py-1 font-mono text-xs break-all whitespace-pre-wrap">
                {row.message}
              </span>
            </div>
          )
      ))}
    </ScrollArea>
  )
}
