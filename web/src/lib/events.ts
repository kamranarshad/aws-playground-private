import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/**
 * Subscribes to Server-Sent Events from `/api/events` and invalidates
 * the corresponding React Query caches when real-time backend updates occur.
 */
export function useServerEvents() {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return

    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      try {
        es = new EventSource('/api/events')

        es.addEventListener('functions', () => {
          queryClient.invalidateQueries({ queryKey: ['functions'] })
        })

        es.addEventListener('triggers', () => {
          queryClient.invalidateQueries({ queryKey: ['triggers'] })
        })

        es.addEventListener('services', () => {
          queryClient.invalidateQueries({ queryKey: ['services'] })
        })

        es.addEventListener('history', (e) => {
          try {
            const data = JSON.parse(e.data)
            if (data?.functionId) {
              queryClient.invalidateQueries({ queryKey: ['history', data.functionId] })
              queryClient.invalidateQueries({ queryKey: ['function-stats', data.functionId] })
            } else {
              queryClient.invalidateQueries({ queryKey: ['history'] })
            }
          } catch {
            queryClient.invalidateQueries({ queryKey: ['history'] })
          }
        })

        es.onerror = () => {
          es?.close()
          es = null
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null
              connect()
            }, 5000)
          }
        }
      } catch {
        // Fall back gracefully if EventSource is blocked or unsupported
      }
    }

    connect()

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      es = null
    }
  }, [queryClient])
}
