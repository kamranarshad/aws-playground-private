import { Outlet, createRootRoute, Link } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppNav } from '@/components/app-nav'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { useReleaseSelectionOnUnload } from '@/lib/queries'
import { useServerEvents } from '@/lib/events'
import { ThemeProvider } from '@/lib/theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFound,
})

function AppShell() {
  useServerEvents()
  return (
    <div className="flex h-screen">
      <AppNav />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  )
}

function RootComponent() {
  // At the root, not on the function page: closing the tab from /services
  // must release the selection too.
  useReleaseSelectionOnUnload()
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell />
        <Toaster richColors />
      </ThemeProvider>
    </QueryClientProvider>
  )
}

function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="text-muted-foreground font-mono text-sm">Page not found</p>
      <Button asChild size="sm">
        <Link to="/">Back home</Link>
      </Button>
    </div>
  )
}
