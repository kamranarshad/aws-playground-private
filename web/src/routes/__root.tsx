import type { ReactNode } from 'react'
import { Outlet, createRootRoute, HeadContent, Link, Scripts } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppNav } from '@/components/app-nav'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { useReleaseSelectionOnUnload } from '@/lib/queries'
import { ThemeProvider } from '@/lib/theme'
import appCss from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Lambda Playground' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
})

function RootComponent() {
  // At the root, not on the function page: closing the tab from /services
  // must release the selection too.
  useReleaseSelectionOnUnload()
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <div className="flex h-screen">
            <AppNav />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Outlet />
            </div>
          </div>
          <Toaster richColors />
        </ThemeProvider>
      </QueryClientProvider>
    </RootDocument>
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

// Set the theme class before first paint so the stored preference never flashes
// the wrong way during hydration. Dark is the house default when nothing is
// stored; a saved preference always wins. Reads the key the ThemeProvider writes.
const themeScript = `(function(){try{var t=localStorage.getItem('awsplay-theme');if(t!=='light'&&t!=='dark'){t='dark';}document.documentElement.classList.toggle('dark',t==='dark');}catch(e){}})();`

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
