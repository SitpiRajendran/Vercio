import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { EnvironmentView, OverviewEnvironment, ProjectView } from '@vercio/shared'
import { useContainerActions } from '@/components/containers/container-actions'
import { ContainerList } from '@/components/containers/container-list'
import { ResourcesCard } from '@/components/containers/resources-card'
import { ActivityList } from '@/components/events/activity-list'
import { EnvironmentPorts } from '@/components/projects/environment-ports'
import { EnvironmentNetworks } from '@/components/networks/environment-networks'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { EnvTarget } from '@/components/workbench/workbench'
import { api } from '@/lib/api'
import { useUsage } from '@/lib/overview'

/** Vue d'ensemble d'un environnement : conteneurs, consommation, liens et activité. */
export function OverviewTab({
  project,
  environment,
  live,
  target,
  actions,
  isAdmin,
}: {
  project: ProjectView
  environment: EnvironmentView
  /** Conteneurs à jour (vue d'ensemble) ; absent pendant le chargement. */
  live: OverviewEnvironment | undefined
  target: EnvTarget
  actions: ReturnType<typeof useContainerActions>
  isAdmin: boolean
}) {
  const usage = useUsage()
  const activity = useQuery({
    queryKey: ['events', 'activity', 'project', project.slug],
    queryFn: () => api.events.activity({ project: project.slug, limit: 15 }),
    refetchInterval: 15_000,
    select: (items) => items.filter((item) => item.environment.slug === environment.slug),
  })
  const last = environment.lastDeployment

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-4">
        {last?.status === 'failed' && (
          <div className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm">
            <p className="font-medium">Le dernier déploiement a échoué</p>
            {last.error && <p className="text-muted-foreground mt-1 text-xs">{last.error}</p>}
            <p className="text-muted-foreground mt-1 text-xs">
              Les conteneurs « jamais démarrés » sont ceux qu’il a créés sans pouvoir les lancer :
              ils seront remplacés au prochain déploiement réussi.{' '}
              <Link
                to="/projets/$slug/deploiements/$deploymentId"
                params={{ slug: project.slug, deploymentId: last.id }}
                className="underline underline-offset-4"
              >
                Voir le journal
              </Link>
            </p>
          </div>
        )}
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Conteneurs</CardTitle>
            <CardDescription>
              Pastille, ports ouverts (lien, ou cadenas si l’accès est réservé à l’hôte), processeur
              et mémoire. État mis à jour toutes les 5 s.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!live && <Skeleton className="h-24 w-full" />}
            {live && live.containers.length === 0 && (
              <p className="text-muted-foreground py-6 text-center text-sm">
                Aucun conteneur : l’environnement n’a pas encore été déployé.
              </p>
            )}
            {live && live.containers.length > 0 && (
              <ContainerList
                target={target}
                containers={live.containers}
                usage={usage.data}
                alerts={live.alerts}
                actions={actions}
              />
            )}
          </CardContent>
        </Card>
        <ResourcesCard projectId={project.id} envId={environment.id} />
      </div>
      <aside className="min-w-0 space-y-4">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Liens avec d’autres projets</CardTitle>
            <CardDescription>
              Services d’autres projets joints par un nom, et ceux que ce projet partage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EnvironmentNetworks project={project} environment={environment} canEdit={isAdmin} />
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Ports ouverts</CardTitle>
            <CardDescription>Ports du serveur ouverts vers les conteneurs.</CardDescription>
          </CardHeader>
          <CardContent>
            <EnvironmentPorts
              project={project}
              environment={environment}
              live={live}
              target={target}
            />
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Activité</CardTitle>
            <CardDescription>Déploiements, pushs, redémarrages et pannes.</CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isPending && <Skeleton className="h-24 w-full" />}
            {activity.data?.length === 0 && (
              <p className="text-muted-foreground text-sm">Rien pour le moment.</p>
            )}
            {activity.data && activity.data.length > 0 && (
              <ActivityList items={activity.data} compact showProject={false} />
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}
