import type { ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Database } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type NavItem = { to: string; label: string; exact?: boolean; icon: ReactNode }

// The rail carries the app's identity mark (λ) and top-level destinations.
// Built to take more entries later (Settings, Logs) without touching pages.
const ITEMS: NavItem[] = [
  { to: '/', label: 'Playground', exact: true, icon: <span className="font-mono text-base leading-none">λ</span> },
  { to: '/services', label: 'Services', icon: <Database className="size-4" /> },
]

export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1 border-r bg-card py-3">
      {/* One provider for the whole rail — separate providers per item let
          multiple tooltips open at once (Task 7's lesson). */}
      <TooltipProvider delayDuration={0}>
        {ITEMS.map((item) => {
          const active = item.exact ? pathname === item.to : pathname.startsWith(item.to)
          return (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>
                <Link
                  to={item.to}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-md transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  {item.icon}
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </TooltipProvider>
    </nav>
  )
}
