import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { JsonTree, jsonLeafClass } from '@/components/json-tree'
import { parseLogs, type LogLevel, type LogRow } from '@/lib/log-lines'
import { cn } from '@/lib/utils'

// Light/dark pairs, matching the leaf colours in json-tree.tsx.
const LEVEL_TEXT: Record<LogLevel, string> = {
  error: 'text-destructive',
  warn: 'text-brand',
  info: 'text-sky-700 dark:text-sky-300',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
}

// The left edge bar is the tell that reads before any text does, so it wants
// a flat saturated colour rather than the text pair.
const LEVEL_BAR: Record<LogLevel, string> = {
  error: 'bg-destructive',
  warn: 'bg-brand',
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

// Scalars read as themselves; a nested object or array is summarised, since
// a whole stack inlined would bury the message it belongs to. The chevron is
// there for those — this is a summary, not the payload.
function metaValue(value: unknown): string {
  if (Array.isArray(value)) return '[…]'
  if (value !== null && typeof value === 'object') return '{…}'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

// The leftovers as compact JSON rather than key=value text, coloured off the
// same palette as the response tree so a log attribute and a response field
// read alike. Flat inline spans, no wrapper per pair: the one-line clamp
// below lays out with -webkit-box-orient vertical, which counts each child
// box as a line, so a span per pair clamps after the first pair instead of
// at the edge of the row.
function MetaJson({ entries }: { entries: [string, unknown][] }) {
  return (
    <>
      <span className="text-muted-foreground">{'{'}</span>
      {entries.map(([key, value], i) => (
        <Fragment key={key}>
          {i > 0 && <span className="text-muted-foreground">, </span>}
          <span className="text-foreground/75">{JSON.stringify(key)}</span>
          <span className="text-muted-foreground">: </span>
          <span className={jsonLeafClass(value)}>{metaValue(value)}</span>
        </Fragment>
      ))}
      <span className="text-muted-foreground">{'}'}</span>
    </>
  )
}

// A structured line shows its message, then whatever the columns didn't
// consume — the same information the text format prints after its own
// message, so the two shapes read alike. The full object, including any
// stack logged as an attribute, is one click down rather than folded into
// the message, so a long trace can't push the rest of the list off screen.
function LogLine({ row, hasTime, hasAttrs }: {
  row: Extract<LogRow, { kind: 'line' }>
  hasTime: boolean
  hasAttrs: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('border-b border-border/40', row.level === 'error' && 'bg-destructive/5')}>
      <div className="flex items-start gap-2 pr-3 hover:bg-muted/40">
        {/* self-stretch so the bar runs the full height of a folded trace. */}
        <span
          aria-hidden="true"
          className={cn('w-0.5 shrink-0 self-stretch',
            row.level ? LEVEL_BAR[row.level] : 'bg-transparent')}
        />
        {/* Only rendered when something in the batch is expandable, so plain
            text logs don't carry a dead gutter — and a spacer where a row
            has no attributes, so the columns still line up beside one that
            does. Same per-batch rule as the time cell. */}
        {hasAttrs && (row.attrs
          ? (
            <button
              type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} log entry: ${row.message}`}
              className="mt-1.5 shrink-0 rounded text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </button>
          )
          : <span className="w-3.5 shrink-0" aria-hidden="true" />)}
        {/* Both cells keep their width when empty, so the message column
            stays put down a list of mixed lines; the time cell itself
            disappears only when no row in the whole batch has one. */}
        <span className={cn(TIME_CELL, !hasTime && 'hidden')}>{row.time}</span>
        <span className={cn(LEVEL_CELL, row.level && LEVEL_TEXT[row.level])}>
          {row.level?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 py-1 font-mono text-xs">
          <span className="block whitespace-pre-wrap wrap-anywhere">{row.message}</span>
          {row.meta && row.meta.length > 0 && (
            // Its own line, clamped to one. Datadog's intake wants service,
            // ddsource and ddtags on every entry, so inlining the lot after
            // the message turned each row four lines tall and identical for
            // three of them — the list stopped being scannable. One line
            // each keeps the row height uniform; the chevron has the rest.
            // line-clamp rather than truncate: truncate sets nowrap, and the
            // Radix scroll viewport sizes to its content, so a nowrap line
            // widens the whole list instead of ellipsing inside it.
            // No `block` here: line-clamp sets display itself, and block
            // would win the cascade and silently turn the clamp off.
            <span className="line-clamp-1">
              <MetaJson entries={row.meta} />
            </span>
          )}
        </span>
      </div>
      {open && row.attrs && (
        <div className="border-t border-border/40 bg-muted/20 pl-6">
          <JsonTree value={row.attrs} />
        </div>
      )}
    </div>
  )
}

export function LogViewer({ raw }: { raw: string | undefined }) {
  const rows = useMemo(() => parseLogs(raw ?? ''), [raw])

  if (!rows.length) {
    return <p className="p-3 font-mono text-xs text-muted-foreground">No logs.</p>
  }

  // Per batch, not per row: python `logging`'s default format has no
  // timestamp at all, and if every row hid its own empty cell the column
  // would still show up as ragged dead space wherever a timed line sat next
  // to an untimed one. Hiding the whole column only when nothing in the
  // batch has a time keeps mixed logs aligned, which is the same alignment
  // concern the per-row empty cell below is protecting.
  const hasTime = rows.some((row) => row.kind === 'line' && row.time)
  const hasAttrs = rows.some((row) => row.kind === 'line' && row.attrs)

  return (
    <ScrollArea className="h-full">
      {rows.map((row, i) => (
        row.kind === 'divider'
          ? (
            <div key={i} className="flex items-center gap-2 bg-surface-strip px-3 py-1">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {row.label}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          )
          : <LogLine key={i} row={row} hasTime={hasTime} hasAttrs={hasAttrs} />
      ))}
    </ScrollArea>
  )
}
