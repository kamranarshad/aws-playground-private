import { Columns2, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PaneLayout } from '@/lib/use-layout'

// Takes the layout as props rather than calling useLayout() itself: the hook
// is plain useState, not a context, so a second call here would be a second
// independent copy and the button would drift out of sync with the panes.
export function LayoutToggle({ layout, onToggle }: {
  layout: PaneLayout
  onToggle: () => void
}) {
  const stacked = layout === 'stacked'
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label="Toggle pane layout"
      // The icon shows what you get by clicking, the way ThemeToggle shows a
      // sun while dark.
      title={stacked ? 'Place panes side by side' : 'Stack panes'}
    >
      {stacked ? <Columns2 className="size-4" /> : <Rows2 className="size-4" />}
    </Button>
  )
}
