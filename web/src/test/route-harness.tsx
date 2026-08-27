import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { App, validateSearch } from '@/routes/index'

// Deliberately not the real `web/src/routes/__root.tsx` (via `getRouter()`
// from `@/router`): that root renders a full <html><head><body> shell for
// TanStack Start's SSR. Nested inside RTL's own container div, that
// produces a duplicate <body> — the render succeeds but every click
// afterward silently never resolves. This bare root sidesteps that.
//
// Also deliberately not the file-bound `Route` export from `@/routes/index`:
// reparenting it onto a different root throws "Duplicate routes found with
// id: __root__". A fresh `createRoute` reusing the real `App` and
// `validateSearch` avoids that — `Route.useSearch()`/`Route.useNavigate()`
// inside `App` still resolve correctly here, keyed by route id ("/"), not
// by the object identity of the original `Route` export.
export async function renderApp(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider>,
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch,
    component: App,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}
