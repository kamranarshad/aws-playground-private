import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions')({
  server: {
    handlers: {
      GET: async () => toResponse(backend.listFunctions()),
      POST: async ({ request }) => toResponse(backend.createFunction(await jsonBody(request))),
    },
  },
})
