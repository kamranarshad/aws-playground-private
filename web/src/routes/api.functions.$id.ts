import { createFileRoute } from '@tanstack/react-router'
import { backend, jsonBody, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        toResponse(backend.updateFunction(params.id, await jsonBody(request))),
      DELETE: async ({ params }) => toResponse(backend.deleteFunction(params.id)),
    },
  },
})
