import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/detect')({
  server: {
    handlers: {
      POST: async ({ request }) => toResponse(backend.detect(await jsonBody(request))),
    },
  },
})
