import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/functions/$id/history/$requestId/trace')({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(backend.getInvokeTrace(params.id, params.requestId)),
    },
  },
})
