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

export function useClearHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.clearHistory(id),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: ['history', id] }),
    onError: onApiError,
  })
}
