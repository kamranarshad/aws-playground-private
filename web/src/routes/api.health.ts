import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => toResponse(await backend.health()),
    },
  },
})
