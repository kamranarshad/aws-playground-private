import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/selection')({
  server: {
    handlers: {
      POST: async ({ request }) => toResponse(await backend.setSelection(await jsonBody(request))),
    },
  },
})
