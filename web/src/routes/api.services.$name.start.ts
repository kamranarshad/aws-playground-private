import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/services/$name/start')({
  server: {
    handlers: {
      POST: async ({ params }) => toResponse(await backend.startService(params.name)),
    },
  },
})
