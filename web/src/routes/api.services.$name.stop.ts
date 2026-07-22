import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/services/$name/stop')({
  server: {
    handlers: {
      POST: async ({ params }) => toResponse(await backend.stopService(params.name)),
    },
  },
})
