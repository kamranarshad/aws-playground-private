import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type InvokePayload } from './api'
import type { FunctionDef } from './types'

export function useFunctions() {
  return useQuery({
    queryKey: ['functions'],
    queryFn: api.listFunctions,
    select: (d) => d.functions,
  })
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
}

export function useHistoryQuery(id: string | null) {
  return useQuery({
    queryKey: ['history', id],
    queryFn: () => api.listHistory(id!),
    enabled: !!id,
    select: (d) => d.entries,
  })
}

function onApiError(err: Error) {
  toast.error(err.message)
}

export function useCreateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<FunctionDef>) => api.createFunction(input),
    onSuccess: (fn) => {
      qc.setQueryData<{ functions: FunctionDef[] }>(['functions'], (d) =>
        d ? { functions: [...d.functions.filter((f) => f.id !== fn.id), fn] } : d,
      )
      qc.invalidateQueries({ queryKey: ['functions'] })
    },
  })
}

export function useUpdateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<FunctionDef> }) =>
      api.updateFunction(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['functions'] }),
    onError: onApiError,
  })
}

export function useDeleteFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteFunction(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['functions'] }),
    onError: onApiError,
  })
}

export function useInvoke() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: InvokePayload) => api.invoke(payload),
    onSuccess: (_r, payload) =>
      qc.invalidateQueries({ queryKey: ['history', payload.functionId] }),
    onError: onApiError,
  })
}

// Container state changes behind the app's back — `docker stop` in a
// terminal, a crash, an OOM kill. Poll so the page stops claiming
// "running". refetchIntervalInBackground defaults to false, so an
// unfocused tab isn't spawning `docker inspect` every few seconds.
export const SERVICES_POLL_MS = 5_000

export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn: api.listServices,
    refetchInterval: SERVICES_POLL_MS,
  })
}

export function useServiceAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'start' | 'stop' }) =>
      action === 'start' ? api.startService(name) : api.stopService(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }),
    onError: onApiError,
  })
}

export function useSelectionSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (functionId: string | null) => api.setSelection(functionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }),
    // Selection sync is best-effort; a failure just means services stay put.
  })
}

// Closing the tab ends the selection, but nothing tells the server that —
// so the last selection's services stayed up indefinitely. sendBeacon is
// the only request that reliably survives page teardown. Releasing the
// selection starts the normal grace timer, so a reload that comes back
// within the window cancels its own stop.
export function useReleaseSelectionOnUnload() {
  useEffect(() => {
    function release() {
      navigator.sendBeacon?.(
        '/api/selection',
        new Blob([JSON.stringify({ functionId: null })], { type: 'application/json' }),
      )
    }
    window.addEventListener('beforeunload', release)
    return () => window.removeEventListener('beforeunload', release)
  }, [])
}

export function useClearHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.clearHistory(id),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: ['history', id] }),
    onError: onApiError,
  })
}
