import type { EnvironmentView, OverviewEnvironment, ProjectView } from '@vercio/shared'
import { PortsTable } from '@/components/map/ports-table'
import { TopologyMap } from '@/components/map/topology-map'
import { EnvironmentNetworks } from '@/components/networks/environment-networks'
import { useSharedNetworks } from '@/components/networks/dependencies'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkbench } from '@/components/workbench/workbench'
import { useOverview } from '@/lib/overview'
import { buildTopology } from '@/lib/topology'

/** Carte d'un environnement, avec les projets reliés par un réseau partagé. */
export function MapTab({
  project,
  environment,
}: {
  project: ProjectView
  environment: EnvironmentView
  live: OverviewEnvironment | undefined
}) {
  const { isAdmin } = useWorkbench()
  const overview = useOverview()
  const networks = useSharedNetworks()
  if (!overview.data || !networks.data) return <Skeleton className="h-96 w-full" />
  const topology = buildTopology(overview.data.projects, networks.data, [environment.id])
  const own = topology.ports.filter((item) => item.item.env.id === environment.id)
  return (
    <div className="space-y-8">
      <TopologyMap
        topology={topology}
        sharedActions={
          isAdmin && (
            <EnvironmentNetworks project={project} environment={environment} canEdit actionsOnly />
          )
        }
      />
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Ports ouverts</h2>
        <PortsTable ports={own} showProject={false} />
      </section>
    </div>
  )
}
