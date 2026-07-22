import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/services')({
  server: {
    handlers: {
      GET: async () => toResponse(await backend.listServices()),
    },
  },
})
