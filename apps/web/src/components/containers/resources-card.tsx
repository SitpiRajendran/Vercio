import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import type { ContainerStatsSample, ContainerStatsView } from '@vercio/shared'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { Sparkline } from './sparkline'

const percent = (value: number) =>
  `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 ? 1 : 0 })} %`
const rate = (value: number) => `${formatBytes(value)}/s`

/** Débit moyen entre les deux dernières mesures. */
function rates(samples: ContainerStatsSample[]) {
  const [previous, last] = samples.slice(-2)
  if (!previous || !last || previous === last) return null
  const seconds = (Date.parse(last.at) - Date.parse(previous.at)) / 1000
  if (seconds <= 0) return null
  const per = (key: keyof ContainerStatsSample) =>
    Math.max(0, ((last[key] as number) - (previous[key] as number)) / seconds)
  return {
    rx: per('netRxBytes'),
    tx: per('netTxBytes'),
    read: per('blockReadBytes'),
    write: per('blockWriteBytes'),
  }
}

/** CPU, mémoire, réseau et disque des conteneurs en marche, avec 10 minutes d'historique. */
export function ResourcesCard({ projectId, envId }: { projectId: string; envId: string }) {
  const stats = useQuery({
    queryKey: ['containers', envId, 'stats'],
    queryFn: () => api.containers.stats(projectId, envId),
    refetchInterval: 5000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" />
          Ressources
        </CardTitle>
        <CardDescription>
          Mesurées toutes les 5 s pendant que cette page est ouverte ; 10 minutes d’historique,
          gardées en mémoire par Vercio.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {stats.isPending && <Skeleton className="h-24 w-full" />}
        {stats.error && <p className="text-destructive text-sm">{stats.error.message}</p>}
        {stats.data?.length === 0 && (
          <p className="text-muted-foreground py-4 text-center text-sm">
            Aucun conteneur en marche.
          </p>
        )}
        {!!stats.data?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Service</th>
                  <th className="py-2 pr-4 font-medium">CPU</th>
                  <th className="py-2 pr-4 font-medium">Mémoire</th>
                  <th className="py-2 pr-4 font-medium">Réseau</th>
                  <th className="py-2 pr-4 font-medium">Disque</th>
                  <th className="py-2 font-medium">Processus</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stats.data.map((view) => (
                  <ResourceRow key={view.id} view={view} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ResourceRow({ view }: { view: ContainerStatsView }) {
  const last = view.samples.at(-1)
  const times = view.samples.map((sample) => sample.at)
  const flow = rates(view.samples)
  return (
    <tr className="align-middle">
      <td className="py-2 pr-4">
        <p className="font-medium">{view.service || view.name}</p>
        <p className="text-muted-foreground font-mono text-xs">{view.name}</p>
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-3">
          <Sparkline
            label="CPU"
            values={view.samples.map((sample) => sample.cpuPercent)}
            times={times}
            max={100}
            format={percent}
          />
          <span className="w-14 text-right tabular-nums">
            {last?.cpuPercent != null ? percent(last.cpuPercent) : '—'}
          </span>
        </div>
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-3">
          <Sparkline
            label="Mémoire"
            values={view.samples.map((sample) => sample.memoryBytes)}
            times={times}
            format={formatBytes}
          />
          <span className="text-right whitespace-nowrap tabular-nums">
            {last ? formatBytes(last.memoryBytes) : '—'}
            {last && (
              <span className="text-muted-foreground block text-xs">
                sur {formatBytes(last.memoryLimitBytes)}
              </span>
            )}
          </span>
        </div>
      </td>
      <td className="py-2 pr-4 text-xs whitespace-nowrap tabular-nums">
        {flow ? (
          <>
            <p>↓ {rate(flow.rx)}</p>
            <p>↑ {rate(flow.tx)}</p>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 pr-4 text-xs whitespace-nowrap tabular-nums">
        {flow ? (
          <>
            <p>Lecture {rate(flow.read)}</p>
            <p>Écriture {rate(flow.write)}</p>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 tabular-nums">{last?.pids ?? '—'}</td>
    </tr>
  )
}
