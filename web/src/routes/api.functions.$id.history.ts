import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id/history')({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(backend.listHistory(params.id)),
      DELETE: async ({ params }) => toResponse(backend.clearHistory(params.id)),
    },
  },
})
