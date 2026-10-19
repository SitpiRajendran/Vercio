import { useQuery } from '@tanstack/react-query'
import { Box, Cpu, HardDrive, Layers } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DiskUsageView } from '@vercio/shared'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Docker et disques de l'hôte. */
export function HostCards() {
  const docker = useQuery({
    queryKey: ['system', 'docker'],
    queryFn: api.dockerInfo,
    refetchInterval: 15_000,
    retry: false,
  })
  const disk = useQuery({
    queryKey: ['system', 'disk'],
    queryFn: api.diskUsage,
    refetchInterval: 60_000,
    retry: false,
  })
  return (
    <>
      {docker.isError && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Démon Docker injoignable</CardTitle>
            <CardDescription>
              Vérifiez que le socket Docker est monté dans le conteneur Vercio (
              <code>/var/run/docker.sock</code>).
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={<Box />}
          label="Conteneurs actifs"
          loading={docker.isPending}
          value={
            docker.data
              ? `${docker.data.containers.running} / ${docker.data.containers.total}`
              : '—'
          }
          hint={docker.data && `${docker.data.containers.stopped} arrêté(s)`}
        />
        <StatCard
          icon={<Layers />}
          label="Images"
          loading={docker.isPending}
          value={docker.data?.images ?? '—'}
        />
        <StatCard
          icon={<Cpu />}
          label="Processeurs"
          loading={docker.isPending}
          value={docker.data?.cpus ?? '—'}
          hint={docker.data?.architecture}
        />
        <StatCard
          icon={<HardDrive />}
          label="Mémoire"
          loading={docker.isPending}
          value={docker.data ? formatBytes(docker.data.memoryBytes) : '—'}
          hint={docker.data && `Docker ${docker.data.serverVersion}`}
        />
      </div>

      {disk.data && disk.data.length > 0 && <DiskCard usage={disk.data} />}
    </>
  )
}

function StatCard({
  icon,
  label,
  value,
  hint,
  loading,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  hint?: ReactNode
  loading: boolean
}) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardAction className="text-muted-foreground [&_svg]:size-4">{icon}</CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        )}
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  )
}

const LEVEL_LABELS: Record<DiskUsageView['level'], string> = {
  ok: 'Normal',
  low: 'Faible',
  critical: 'Critique',
}

/** Espace libre par disque surveillé, avec le seuil d'alerte des notifications. */
function DiskCard({ usage }: { usage: DiskUsageView[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          Espace disque
        </CardTitle>
        <CardDescription>
          Alerte envoyée aux canaux de notification sous le seuil indiqué.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {usage.map((item) => {
          const used = item.totalBytes - item.freeBytes
          const percent = item.totalBytes ? Math.round((used / item.totalBytes) * 100) : 0
          const threshold = item.totalBytes
            ? 100 - Math.round((item.lowThresholdBytes / item.totalBytes) * 100)
            : 100
          return (
            <div key={item.path} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium first-letter:uppercase">{item.label}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatBytes(item.freeBytes)} libres sur {formatBytes(item.totalBytes)}
                </span>
              </div>
              <div
                className="bg-muted relative h-2 overflow-hidden rounded-full"
                role="meter"
                aria-label={`Espace utilisé : ${item.label}`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={cn(
                    'h-full rounded-full',
                    item.level === 'critical'
                      ? 'bg-destructive'
                      : item.level === 'low'
                        ? 'bg-warning'
                        : 'bg-primary',
                  )}
                  style={{ width: `${percent}%` }}
                />
                <div
                  className="bg-foreground/40 absolute inset-y-0 w-px"
                  style={{ left: `${threshold}%` }}
                  title="Seuil d’alerte"
                />
              </div>
              <div className="text-muted-foreground flex flex-wrap justify-between gap-2 text-xs">
                <span>
                  <code>{item.path}</code> · seuil d’alerte : {formatBytes(item.lowThresholdBytes)}{' '}
                  libres
                  {item.freeInodesRatio !== null &&
                    ` · inodes libres : ${Math.round(item.freeInodesRatio * 100)} %`}
                </span>
                <span
                  className={cn(
                    item.level === 'critical' && 'text-destructive',
                    item.level === 'low' && 'text-warning',
                  )}
                >
                  {LEVEL_LABELS[item.level]}
                </span>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
