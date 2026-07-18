import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/invoke')({
  server: {
    handlers: {
      POST: async ({ request }) => toResponse(await backend.invokeFunction(await jsonBody(request))),
    },
  },
})
