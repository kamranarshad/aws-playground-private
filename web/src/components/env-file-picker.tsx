import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDetect, useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

// Which .env file to load before every invoke: 'auto' (.env if present),
// 'none', or a specific .env.* file found in the project.
export function EnvFilePicker({ fn }: { fn: FunctionDef }) {
  const update = useUpdateFunction()
  const { data: envFiles = [] } = useDetect(fn.path, (d) => d.envFiles ?? [])
  const envFile = fn.envFile ?? 'auto'
  const hasDotEnv = envFiles.includes('.env')

  // A file chosen earlier and since deleted still needs an option to render
  // against, or the trigger would go blank and lose the setting silently.
  const options = envFiles.includes(envFile) || envFile === 'auto' || envFile === 'none'
    ? envFiles
    : [...envFiles, envFile]

  return (
    <Select value={envFile}
      onValueChange={(v) => update.mutate({ id: fn.id, patch: { envFile: v } })}>
      <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label="Env file">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">{hasDotEnv ? 'Auto (.env)' : 'Auto (no .env)'}</SelectItem>
        <SelectItem value="none">None</SelectItem>
        {options.map((f) => (
          <SelectItem key={f} value={f}>{f}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
