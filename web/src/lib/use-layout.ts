import { useCallback, useState } from 'react'

export type PaneLayout = 'split' | 'stacked'

// Which way the Event/Result panes are arranged. A workspace preference, not
// content: the URL carries what you are looking at (see the url-state-sync
// spec -- `function`, `tab`, `traceView`, all of them linkable), while how
// your panes are arranged belongs with the theme, in localStorage.
const STORAGE_KEY = 'awsplay-layout'
const DEFAULT: PaneLayout = 'split'

// Reads throw in private-mode browsers just as writes do. Losing the
// preference is acceptable; taking the page down with it is not.
function readStored(): PaneLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'split' || stored === 'stacked' ? stored : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function useLayout() {
  const [layout, setLayout] = useState<PaneLayout>(readStored)

  const toggle = useCallback(() => {
    setLayout((current) => {
      const next: PaneLayout = current === 'split' ? 'stacked' : 'split'
      try { localStorage.setItem(STORAGE_KEY, next) } catch {}
      return next
    })
  }, [])

  return { layout, toggle }
}
