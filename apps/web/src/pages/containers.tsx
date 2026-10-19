import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Boxes, Eraser, FolderInput, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  CLEANUP_LABELS,
  CLEANUP_TARGETS,
  hasRole,
  type CleanupTarget,
  type HostContainerView,
} from '@vercio/shared'
import { HostCards } from '@/components/host/host-cards'
import { PageHeader } from '@/components/layout/app-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/auth'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

export function ContainersPage() {
  const { data: user } = useCurrentUser()
  const isAdmin = user ? hasRole(user.roles, 'vercio-admin') : false
  return (
    <>
      <PageHeader
        title="Hôte"
        description="Docker, disques, tous les conteneurs de la machine et nettoyage"
      />
      <div className="space-y-6 p-4 md:p-6">
        <HostCards />
        <HostContainers isAdmin={isAdmin} />
        {isAdmin && <Cleanup />}
      </div>
    </>
  )
}

interface Group {
  key: string
  title: string
  kind: 'vercio' | 'compose' | 'single'
  link?: { slug: string; env: string }
  containers: HostContainerView[]
}

function groupContainers(containers: HostContainerView[]): Group[] {
  const groups = new Map<string, Group>()
  for (const container of containers) {
    let key: string
    let group: Omit<Group, 'containers'>
    if (container.vercio) {
      key = `vercio:${container.vercio.project}/${container.vercio.environment}`
      group = {
        key,
        title: `${container.vercio.project} / ${container.vercio.environment}`,
        kind: 'vercio',
        link: { slug: container.vercio.project, env: container.vercio.environment },
      }
    } else if (container.composeProject) {
      key = `compose:${container.composeProject}`
      group = { key, title: container.composeProject, kind: 'compose' }
    } else {
      key = 'single'
      group = { key, title: 'Conteneurs isolés', kind: 'single' }
    }
    const existing = groups.get(key)
    if (existing) existing.containers.push(container)
    else groups.set(key, { ...group, containers: [container] })
  }
  const order = { vercio: 0, compose: 1, single: 2 }
  return [...groups.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title),
  )
}

function StateBadge({ container }: { container: HostContainerView }) {
  const running = container.state === 'running'
  const unhealthy = container.health === 'unhealthy'
  return (
    <Badge variant="outline" title={container.status}>
      <span
        className={cn(
          'size-2 rounded-full',
          unhealthy ? 'bg-warning' : running ? 'bg-success' : 'bg-muted-foreground',
        )}
      />
      {unhealthy
        ? 'Unhealthy'
        : running
          ? 'En marche'
          : container.state === 'exited'
            ? 'Arrêté'
            : container.state}
    </Badge>
  )
}

function HostContainers({ isAdmin }: { isAdmin: boolean }) {
  const containers = useQuery({
    queryKey: ['system', 'containers'],
    queryFn: api.hostContainers,
    refetchInterval: 15_000,
    retry: false,
  })
  const groups = useMemo(() => groupContainers(containers.data ?? []), [containers.data])
  const running = containers.data?.filter((container) => container.state === 'running').length ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="size-4" />
          Conteneurs de l’hôte
        </CardTitle>
        <CardDescription>
          {containers.data
            ? `${containers.data.length} conteneur(s), ${running} en marche. Ceux lancés hors de Vercio sont affichés en lecture seule.`
            : 'Projets Vercio, autres projets Compose et conteneurs isolés.'}
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Actualiser"
            onClick={() => containers.refetch()}
          >
            <RefreshCw className={cn(containers.isFetching && 'animate-spin')} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        {containers.isPending && <Skeleton className="h-40 w-full" />}
        {containers.error && <p className="text-destructive text-sm">{containers.error.message}</p>}
        {groups.map((group) => (
          <section key={group.key} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={cn('text-sm font-medium', group.kind !== 'single' && 'font-mono')}>
                {group.title}
              </h3>
              {group.kind === 'vercio' && group.link && (
                <Button variant="link" size="sm" className="h-auto p-0" asChild>
                  <Link
                    to="/projets/$slug"
                    params={{ slug: group.link.slug }}
                    search={{ onglet: 'conteneurs', env: group.link.env }}
                  >
                    Ouvrir le projet
                  </Link>
                </Button>
              )}
              {group.kind === 'compose' && (
                <>
                  <Badge variant="secondary">Hors Vercio</Badge>
                  {isAdmin && (
                    <Button variant="link" size="sm" className="h-auto gap-1 p-0" asChild>
                      <Link to="/projets/nouveau">
                        <FolderInput className="size-3.5" />
                        Reprendre dans Vercio
                      </Link>
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {group.containers.map((container) => (
                    <tr key={container.id}>
                      <td className="px-3 py-2">
                        <p className="font-medium">{container.service ?? container.name}</p>
                        <p className="text-muted-foreground font-mono text-xs">{container.name}</p>
                      </td>
                      <td
                        className="text-muted-foreground max-w-72 truncate px-3 py-2 font-mono text-xs"
                        title={container.image}
                      >
                        {container.image}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                        {container.ports.join(', ')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <StateBadge container={container} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}

function Cleanup() {
  const queryClient = useQueryClient()
  const preview = useQuery({
    queryKey: ['system', 'cleanup'],
    queryFn: api.cleanup.preview,
    retry: false,
  })
  const [selected, setSelected] = useState<CleanupTarget[]>(['images-dangling', 'build-cache'])
  const [confirming, setConfirming] = useState(false)
  const run = useMutation({
    mutationFn: () => api.cleanup.run(selected),
    onSuccess: async (result) => {
      setConfirming(false)
      const failures = Object.entries(result.targets).filter(([, item]) => item?.error)
      if (failures.length) {
        toast.error(
          `Nettoyage partiel : ${failures.map(([target, item]) => `${CLEANUP_LABELS[target as CleanupTarget].label} (${item!.error})`).join(', ')}`,
        )
      } else {
        toast.success(`${formatBytes(result.totalBytes)} récupérés`)
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['system'] }),
        queryClient.invalidateQueries({ queryKey: ['events'] }),
      ])
    },
    onError: (error) => toast.error(error.message),
  })

  const total = selected.reduce(
    (sum, target) =>
      // « Images inutilisées » contient déjà les images sans tag.
      target === 'images-dangling' && selected.includes('images-unused')
        ? sum
        : sum + (preview.data?.targets[target].bytes ?? 0),
    0,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eraser className="size-4" />
          Nettoyage
        </CardTitle>
        <CardDescription>
          Espace récupérable sur le disque de Docker. Les volumes nommés et les conteneurs des
          projets Vercio ne sont jamais supprimés.
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Mesurer à nouveau"
            onClick={() => preview.refetch()}
          >
            <RefreshCw className={cn(preview.isFetching && 'animate-spin')} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.isPending && <Skeleton className="h-40 w-full" />}
        {preview.error && <p className="text-destructive text-sm">{preview.error.message}</p>}
        {preview.data && (
          <ul className="divide-y rounded-lg border">
            {CLEANUP_TARGETS.map((target) => {
              const item = preview.data.targets[target]
              return (
                <li key={target} className="flex items-start gap-3 px-3 py-2.5">
                  <Checkbox
                    id={`cleanup-${target}`}
                    className="mt-0.5"
                    checked={selected.includes(target)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked === true
                          ? [...current, target]
                          : current.filter((value) => value !== target),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`cleanup-${target}`}>{CLEANUP_LABELS[target].label}</Label>
                    <p className="text-muted-foreground text-xs">{CLEANUP_LABELS[target].hint}</p>
                  </div>
                  <div className="shrink-0 text-right text-sm tabular-nums">
                    <p className="font-medium">{formatBytes(item.bytes)}</p>
                    <p className="text-muted-foreground text-xs">{item.count} élément(s)</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm">
            Sélection : environ <strong className="text-foreground">{formatBytes(total)}</strong>{' '}
            récupérables.
          </p>
          <Button
            onClick={() => setConfirming(true)}
            disabled={!selected.length || !preview.data || run.isPending}
          >
            <Eraser />
            Nettoyer la sélection
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nettoyer environ {formatBytes(total)} ?</DialogTitle>
            <DialogDescription>
              Suppression définitive :{' '}
              {selected.map((target) => CLEANUP_LABELS[target].label.toLowerCase()).join(', ')}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending && <Loader2 className="animate-spin" />}
              Nettoyer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
