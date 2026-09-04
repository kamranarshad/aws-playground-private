import type { CSSProperties } from 'react'
import { spanGuideGlyph } from '@/lib/trace-layout'
import { cn } from '@/lib/utils'

// A span's name preceded by a fixed-width nesting gutter. Both trace views
// render this same element, so the name text starts at an identical x in each
// -- the geometry lives here rather than being re-derived per view.
export function SpanLabel({ depth, name, className, style }: {
  depth: number
  name: string
  className?: string
  style?: CSSProperties
}) {
  const glyph = spanGuideGlyph(depth)
  return (
    <span data-testid="span-label" className={cn('flex min-w-0 items-baseline gap-2', className)} style={style}>
      {/* Decorative: the nesting is already conveyed by row order, and a
          screen reader reading out box-drawing characters is noise. A
          non-breaking space keeps the gutter's baseline stable at depth 0,
          where it would otherwise have no content to sit on. */}
      <span aria-hidden="true" className="w-4 shrink-0 select-none text-muted-foreground/50">
        {glyph || ' '}
      </span>
      <span className="truncate" title={name}>{name}</span>
    </span>
  )
}
