import { Badge } from '@/components/ui/badge'
import { httpStatusClass, httpStatusOf } from '@/lib/http'
import { cn } from '@/lib/utils'

export function HttpStatusBadge({ response, prefix = true }: {
  response: unknown
  prefix?: boolean
}) {
  const status = httpStatusOf(response)
  if (status === null) return null
  return (
    <Badge variant="outline" className={cn('font-mono tabular-nums text-[10px]', httpStatusClass(status))}>
      {prefix ? `HTTP ${status}` : status}
    </Badge>
  )
}
