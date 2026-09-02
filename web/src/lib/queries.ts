import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type InvokePayload } from './api'
import type { Detection, FunctionDef } from './types'

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

// Project detection is one server-side scan (readdir + source regexes) that
// answers several questions at once. Consumers share the query key and
// narrow with `select`, so N consumers still cost one request.
export function useDetect<T>(path: string, select: (d: Detection) => T) {
  return useQuery({
    queryKey: ['detect', path],
    queryFn: () => api.detect(path),
    select,
  })
}

// A trigger-caused invoke happens server-side, with nothing in the web
// client to invalidate this query the way a manual invoke's mutation does
// (useInvoke, below) — poll so a background trigger's run shows up without
// needing to reselect the function or refocus the window.
export function useHistoryQuery(id: string | null) {
  return useQuery({
    queryKey: ['history', id],
    queryFn: () => api.listHistory(id!),
    enabled: !!id,
    select: (d) => d.entries,
    refetchInterval: SERVICES_POLL_MS,
  })
}

export function useFunctionStats(id: string | null) {
  return useQuery({
    queryKey: ['function-stats', id],
    queryFn: () => api.getStats(id!),
    enabled: !!id,
    refetchInterval: SERVICES_POLL_MS,
  })
}

// Spans for an invoke can still be arriving from the OTLP receiver after the
// response comes back, so poll the trace endpoint while it's pending and
// stop once the last poll (or the initial invoke response) says it's done.
export function useTracePoll(functionId: string | null, requestId: string | null, pending: boolean) {
  return useQuery({
    queryKey: ['trace', functionId, requestId],
    queryFn: () => api.getTrace(functionId!, requestId!),
    enabled: pending && !!functionId && !!requestId,
    refetchInterval: pending ? 1_500 : false,
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
    onError: onApiError,
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
    onSuccess: (_r, payload) => {
      qc.invalidateQueries({ queryKey: ['history', payload.functionId] })
      qc.invalidateQueries({ queryKey: ['function-stats', payload.functionId] })
    },
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

export function useTriggerStatus() {
  return useQuery({
    queryKey: ['triggers'],
    queryFn: api.listTriggerStatus,
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
