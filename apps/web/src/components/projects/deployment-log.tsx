import { useEffect, useRef, useState } from 'react'
import type {
  DeploymentDetail,
  DeploymentEvent,
  DeploymentLogLine,
  DeploymentSummary,
} from '@vercio/shared'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isFinal } from './deployment-status'

/**
 * Journal d'un déploiement : lignes déjà enregistrées, puis flux en direct (SSE) tant que le
 * déploiement n'est pas terminé. À utiliser dans un composant remonté pour chaque déploiement.
 */
export function useDeploymentStream(detail: DeploymentDetail) {
  const [logs, setLogs] = useState<DeploymentLogLine[]>(detail.logs)
  const [summary, setSummary] = useState<DeploymentSummary>(detail)

  useEffect(() => {
    if (isFinal(detail.status)) return
    const source = new EventSource(
      api.deployments.eventsUrl(detail.id, detail.logs.at(-1)?.id ?? 0),
    )
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as DeploymentEvent
      if (event.type === 'log') {
        setLogs((current) =>
          current.some((log) => log.id === event.log.id) ? current : [...current, event.log],
        )
      } else {
        setSummary(event.deployment)
        if (isFinal(event.deployment.status)) source.close()
      }
    }
    return () => source.close()
  }, [detail])

  return { logs, summary }
}

export function DeploymentLog({ logs, live }: { logs: DeploymentLogLine[]; live: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (follow && container.current) container.current.scrollTop = container.current.scrollHeight
  }, [logs, follow])

  return (
    <div
      ref={container}
      role="log"
      aria-live={live ? 'polite' : 'off'}
      aria-label="Journal du déploiement"
      onScroll={(event) => {
        const el = event.currentTarget
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
      }}
      className="h-[28rem] overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
    >
      {logs.length === 0 && <p className="text-zinc-500">En attente…</p>}
      {logs.map((log) => (
        <div key={log.id} className="flex gap-3 whitespace-pre-wrap">
          <span className="shrink-0 text-zinc-500 select-none">
            {new Date(log.at).toLocaleTimeString('fr-FR')}
          </span>
          <span
            className={cn(
              'min-w-0 break-all',
              log.stream === 'stderr' && 'text-amber-300',
              log.stream === 'system' && 'text-sky-300',
              log.line.startsWith('✔') && 'text-emerald-400',
              log.line.startsWith('✖') && 'text-red-400',
            )}
          >
            {log.line}
          </span>
        </div>
      ))}
      {live && <div className="mt-1 h-3 w-2 animate-pulse bg-zinc-400" aria-hidden />}
    </div>
  )
}
