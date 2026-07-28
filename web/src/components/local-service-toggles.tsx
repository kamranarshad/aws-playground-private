import { useDetect, useServices, useUpdateFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

// Which local services a function gets endpoint env vars for.
//
// A project playground.json wins over the manual toggles, so when one is
// present the services are shown read-only — a checkbox that couldn't
// change anything would be a lie. Both the service list and the
// playground.json contents come from queries shared with the rest of the
// editor, so mounting this costs no extra requests.
export function LocalServiceToggles({ fn }: { fn: FunctionDef }) {
  const update = useUpdateFunction()
  const { data: servicesStatus } = useServices()
  const { data: projectServices } = useDetect(fn.path, (d) => d.projectServices ?? null)
  const services = servicesStatus?.services ?? []

  if (projectServices != null) {
    return (
      <span
        className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
        title="Declared in playground.json — edit the file to change"
      >
        {services
          .filter((svc) => projectServices.includes(svc.name))
          .map((svc) => (
            <span key={svc.name} className="rounded bg-surface-strip px-1.5 py-0.5">
              {svc.shortLabel}
            </span>
          ))}
        <span className="normal-case tracking-normal text-muted-foreground/70">
          from playground.json
        </span>
      </span>
    )
  }

  const enabled = fn.localServices ?? []
  function toggle(name: string, on: boolean) {
    update.mutate({
      id: fn.id,
      patch: {
        localServices: on ? [...enabled, name] : enabled.filter((s) => s !== name),
      },
    })
  }

  return (
    <>
      {services.map((svc) => (
        <label
          key={svc.name}
          className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={enabled.includes(svc.name)}
            onChange={(e) => toggle(svc.name, e.target.checked)}
          />
          {svc.shortLabel}
        </label>
      ))}
    </>
  )
}
