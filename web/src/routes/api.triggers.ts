import { createFileRoute } from '@tanstack/react-router'
import { backend, toResponse } from '@/lib/backend'

export const Route = createFileRoute('/api/triggers')({
  server: {
    handlers: {
      GET: async () => toResponse(await backend.listTriggerStatus()),
    },
  },
})
