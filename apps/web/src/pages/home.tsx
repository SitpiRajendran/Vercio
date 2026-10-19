import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  Gauge,
  Plus,
  ScrollText,
  Search,
} from 'lucide-react'
import type { OverviewProject } from '@vercio/shared'
import { AlertChip } from '@/components/containers/container-list'
import { ActivityList } from '@/components/events/activity-list'
import { PageHeader } from '@/components/layout/app-layout'
import { envTarget, ProjectOverviewCard } from '@/components/projects/project-overview-card'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkbench } from '@/components/workbench/workbench'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { containerStatus, useOverview, useUsage } from '@/lib/overview'

/** Accueil : tous les projets, leurs conteneurs, et ce qui demande une action. */
export function HomePage() {
  const overview = useOverview()
  const usage = useUsage()
  const workbench = useWorkbench()
  const [filter, setFilter] = useState('')
  const projects = overview.data?.projects ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? projects.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          project.environments.some((env) =>
            env.containers.some((container) => container.service.toLowerCase().includes(needle)),
          ),
      )
    : projects
  const running = projects
    .flatMap((project) => project.environments)
    .flatMap((env) => env.containers)
    .filter((container) => container.state === 'running').length

  return (
    <>
      <PageHeader
        title="Projets"
        description={
          overview.data
            ? `${projects.length} projet${projects.length > 1 ? 's' : ''} · ${running} conteneur${running > 1 ? 's' : ''} en marche`
            : undefined
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {projects.length > 3 && (
              <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
                <Input
                  aria-label="Filtrer les projets"
                  placeholder="Filtrer…"
                  className="pl-8"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            )}
            {workbench.isAdmin && (
              <Button asChild>
                <Link to="/projets/nouveau">
                  <Plus />
                  Nouveau projet
                </Link>
              </Button>
            )}
          </div>
        }
      />
      <div className="grid gap-6 p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {overview.data?.dockerError && (
            <div className="border-destructive/50 bg-destructive/10 rounded-lg border p-3 text-sm">
              <p className="font-medium">Démon Docker injoignable</p>
              <p className="text-muted-foreground text-xs">
                {overview.data.dockerError}. Vérifiez que le socket Docker est monté dans le
                conteneur Vercio (<code>/var/run/docker.sock</code>).
              </p>
            </div>
          )}
          {overview.data && projects.length > 0 && <Problems projects={projects} />}
          {overview.isPending && <Skeleton className="h-64 w-full" />}
          {overview.error && <p className="text-destructive text-sm">{overview.error.message}</p>}
          {overview.data && projects.length === 0 && (
            <EmptyProjects canCreate={workbench.isAdmin} />
          )}
          <div className="grid gap-4 min-[1900px]:grid-cols-2">
            {shown.map((project) => (
              <ProjectOverviewCard key={project.id} project={project} usage={usage.data} />
            ))}
          </div>
          {needle && shown.length === 0 && (
            <p className="text-muted-foreground text-sm">Aucun projet ne correspond.</p>
          )}
        </div>
        <aside className="min-w-0 space-y-6">
          <RecentActivity />
          <HostSummary />
        </aside>
      </div>
    </>
  )
}

/** Services en erreur et déploiements échoués, avec un accès direct aux logs. */
function Problems({ projects }: { projects: OverviewProject[] }) {
  const workbench = useWorkbench()
  const problems = projects.flatMap((project) =>
    project.environments.flatMap((env) => {
      const several = project.environments.length > 1
      const where = several ? `${project.name} · ${env.name}` : project.name
      const failing = env.containers
        .map((container) => ({ container, status: containerStatus(container) }))
        .filter(({ status }) => status.tone === 'error')
        .map(({ container, status }) => ({
          key: container.id,
          project,
          label: `${container.service} : ${status.label.toLowerCase()}`,
          where,
          onLogs: () => workbench.openLogs(envTarget(project, env), container.service),
        }))
      return failing
    }),
  )
  const watch = projects.flatMap((project) =>
    project.environments.flatMap((env) =>
      env.alerts
        .filter((alert) => alert.active || alert.episodes >= 3)
        .map((alert) => ({ project, env, alert })),
    ),
  )
  const watchSection = watch.length > 0 && (
    <section
      aria-label="À surveiller"
      className="border-warning/40 bg-warning/5 space-y-2 rounded-xl border p-3"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Gauge className="text-warning size-4" />
        Consommation à surveiller
      </p>
      <ul className="space-y-1.5">
        {watch.map(({ project, env, alert }) => (
          <li
            key={`${env.id}-${alert.service}-${alert.metric}`}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <ProjectAvatar project={project} size="sm" />
            <span className="font-medium">{alert.service}</span>
            <AlertChip alert={alert} />
            <span className="text-muted-foreground text-xs">
              {project.environments.length > 1 ? `${project.name} · ${env.name}` : project.name} ·
              pic à {alert.peak} %
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7"
              onClick={() => workbench.openLogs(envTarget(project, env), alert.service)}
            >
              <ScrollText />
              Logs
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
  if (problems.length === 0) {
    return (
      watchSection || (
        <p className="text-success flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4" />
          Aucun service en erreur.
        </p>
      )
    )
  }
  return (
    <>
      <section
        aria-label="À traiter"
        className="border-destructive/40 bg-destructive/5 space-y-2 rounded-xl border p-3"
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="text-destructive size-4" />
          {problems.length} service{problems.length > 1 ? 's' : ''} en erreur
        </p>
        <ul className="space-y-1.5">
          {problems.map((problem) => (
            <li key={problem.key} className="flex flex-wrap items-center gap-2 text-sm">
              <ProjectAvatar project={problem.project} size="sm" />
              <span className="font-medium">{problem.label}</span>
              <span className="text-muted-foreground text-xs">{problem.where}</span>
              <Button variant="outline" size="sm" className="ml-auto h-7" onClick={problem.onLogs}>
                <ScrollText />
                Voir les logs
              </Button>
            </li>
          ))}
        </ul>
      </section>
      {watchSection}
    </>
  )
}

function RecentActivity() {
  const activity = useQuery({
    queryKey: ['events', 'activity', 'home'],
    queryFn: () => api.events.activity({ limit: 5 }),
    refetchInterval: 15_000,
  })
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Activité récente</h2>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/evenements">Tout voir</Link>
        </Button>
      </div>
      {activity.isPending && <Skeleton className="h-40 w-full" />}
      {activity.data?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Déploiements, pushs, redémarrages et pannes apparaîtront ici.
        </p>
      )}
      {activity.data && activity.data.length > 0 && <ActivityList items={activity.data} compact />}
    </section>
  )
}

function HostSummary() {
  const docker = useQuery({
    queryKey: ['system', 'docker'],
    queryFn: api.dockerInfo,
    refetchInterval: 60_000,
    retry: false,
  })
  const disk = useQuery({
    queryKey: ['system', 'disk'],
    queryFn: api.diskUsage,
    refetchInterval: 60_000,
    retry: false,
  })
  const worst = disk.data?.find((item) => item.level !== 'ok')
  return (
    <section className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Hôte</h2>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/conteneurs">Détails</Link>
        </Button>
      </div>
      {docker.data && (
        <p className="text-muted-foreground text-xs">
          {docker.data.cpus} processeurs · {formatBytes(docker.data.memoryBytes)} de mémoire ·
          Docker {docker.data.serverVersion} · {docker.data.containers.running} conteneurs en marche
          sur {docker.data.containers.total}
        </p>
      )}
      {disk.data?.map((item) => (
        <p
          key={item.path}
          className={
            item.level === 'critical'
              ? 'text-destructive text-xs'
              : item.level === 'low'
                ? 'text-warning text-xs'
                : 'text-muted-foreground text-xs'
          }
        >
          Disque {item.label} : {formatBytes(item.freeBytes)} libres sur{' '}
          {formatBytes(item.totalBytes)}
        </p>
      ))}
      {worst && (
        <p className="text-xs">
          <Link to="/conteneurs" className="underline underline-offset-4">
            Libérer de l’espace
          </Link>
        </p>
      )}
    </section>
  )
}

function EmptyProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-14 text-center">
      <FolderGit2 className="text-muted-foreground size-8" />
      <div>
        <p className="font-medium">Aucun projet</p>
        <p className="text-muted-foreground text-sm">
          Un site, une API, une base de données : un projet regroupe un fichier Compose et ses
          conteneurs.
        </p>
      </div>
      {canCreate && (
        <Button asChild>
          <Link to="/projets/nouveau">
            <Plus />
            Nouveau projet
          </Link>
        </Button>
      )}
    </div>
  )
}
