import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// The root and two levels below it arrive expanded; anything deeper starts
// collapsed so a big response doesn't dump hundreds of rows on arrival.
const OPEN_DEPTH = 3

// Guide rail lining up under the parent's chevron. --border is near-invisible
// on the dark background, so tint the rail off the muted text colour instead;
// that reads the same subtle weight in both themes.
const BRANCH = 'ml-[7px] border-l border-muted-foreground/25 pl-3'

type Children = {
  kind: 'array' | 'object'
  entries: [string, unknown][]
  // Stands in for the braces: it says "container", how big, and which kind.
  summary: string
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

// Objects and arrays are the only values with children; everything else is a leaf.
function childrenOf(value: unknown): Children | null {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      entries: value.map((item, i) => [String(i), item]),
      summary: plural(value.length, 'item'),
    }
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    return { kind: 'object', entries, summary: plural(entries.length, 'key') }
  }
  return null
}

// API Gateway proxy responses carry their payload as a JSON *string* in `body`.
// Left as a string that renders as one unreadable line, so treat it as a
// subtree — collapsing the node brings the raw string back.
function embeddedJson(value: unknown): Children | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    const kids = childrenOf(JSON.parse(text))
    // An empty `{}` reads better as the string it is than as an empty subtree.
    return kids && kids.entries.length ? kids : null
  } catch {
    return null
  }
}

function Row({ toggle, children }: {
  toggle?: { open: boolean; label: string; onClick: () => void }
  children: ReactNode
}) {
  // The gap sits on the row, not the chevron, so leaf rows (which fill the
  // chevron column with a spacer) keep the same text origin.
  return (
    <div className="flex items-start gap-1.5">
      {toggle
        ? (
          <button
            type="button" onClick={toggle.onClick} aria-expanded={toggle.open}
            aria-label={`${toggle.open ? 'Collapse' : 'Expand'} ${toggle.label}`}
            className="mt-[3px] shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', toggle.open && 'rotate-90')} />
          </button>
        )
        : <span className="w-3.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 break-all">{children}</div>
    </div>
  )
}

function Key({ label, index }: { label?: string; index?: boolean }) {
  if (label === undefined) return null
  return (
    <>
      <span className={index ? 'text-muted-foreground/70' : 'text-foreground/75'}>{label}</span>
      <span className="text-muted-foreground">: </span>
    </>
  )
}

function Punct({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

// The colour language for a JSON scalar, exported so the log viewer's inline
// attribute summary reads as the same JSON as the tree here rather than
// inventing a second palette that drifts from this one.
export function jsonLeafClass(value: unknown): string {
  if (typeof value === 'string') return 'text-success'
  if (typeof value === 'number') return 'text-sky-700 dark:text-sky-300'
  if (typeof value === 'boolean') return 'text-violet-700 dark:text-violet-300'
  return 'text-muted-foreground'
}

function Leaf({ value }: { value: unknown }) {
  // JSON.stringify, not bare quotes: a value containing a quote or a newline
  // has to stay on its own row.
  if (typeof value === 'string') {
    return <span className={jsonLeafClass(value)}>{JSON.stringify(value)}</span>
  }
  if (typeof value === 'number') return <span className={jsonLeafClass(value)}>{String(value)}</span>
  if (typeof value === 'boolean') return <span className={jsonLeafClass(value)}>{String(value)}</span>
  // null, or undefined for a handler that returned nothing at all.
  return <Punct>{value === null ? 'null' : 'undefined'}</Punct>
}

function Branch({ kids, depth }: { kids: Children; depth: number }) {
  return (
    <div className={BRANCH}>
      {kids.entries.map(([key, child]) => (
        <Node key={key} label={key} index={kids.kind === 'array'} value={child} depth={depth + 1} />
      ))}
    </div>
  )
}

function Node({ label, index, value, depth }: {
  label?: string
  index?: boolean
  value: unknown
  depth: number
}) {
  const kids = childrenOf(value)
  const embedded = kids ? null : embeddedJson(value)
  const [open, setOpen] = useState(depth < OPEN_DEPTH)

  const branch = kids ?? embedded
  if (!branch) return <Row><Key label={label} index={index} /><Leaf value={value} /></Row>

  if (kids && !kids.entries.length) {
    return <Row><Key label={label} index={index} /><Punct>{kids.summary}</Punct></Row>
  }

  return (
    <>
      <Row toggle={{ open, label: label ?? 'root', onClick: () => setOpen(!open) }}>
        <Key label={label} index={index} />
        {!open && embedded
          // Collapsed, an embedded subtree goes back to being the string it is.
          ? <Leaf value={value} />
          : <Punct>{branch.summary}</Punct>}
        {open && embedded && (
          <span className="ml-2 text-[10px] text-muted-foreground/80 italic">parsed from string</span>
        )}
      </Row>
      {open && <Branch kids={branch} depth={depth} />}
    </>
  )
}

export function JsonTree({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn('p-3 font-mono text-xs leading-6', className)}>
      <Node value={value} depth={0} />
    </div>
  )
}
