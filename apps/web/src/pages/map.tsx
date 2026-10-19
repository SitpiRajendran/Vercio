import { useState } from 'react'
import { PageHeader } from '@/components/layout/app-layout'
import { StickyTabsList } from '@/components/layout/sticky-tabs-list'
import { useSharedNetworks } from '@/components/networks/dependencies'
import { PortsTable } from '@/components/map/ports-table'
import { SharedNetworksPanel } from '@/components/map/shared-networks-panel'
import { TopologyMap } from '@/components/map/topology-map'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs'
import { useOverview } from '@/lib/overview'
import { buildTopology } from '@/lib/topology'

/** Qui communique avec qui, et ce qui est ouvert sur l'hôte. */
export function MapPage() {
  const overview = useOverview()
  const networks = useSharedNetworks()
  const [tab, setTab] = useState('carte')
  const topology =
    overview.data && networks.data ? buildTopology(overview.data.projects, networks.data) : null

  return (
    <>
      <PageHeader
        title="Carte et ports"
        description="Qui communique avec qui, par quel réseau, et ce qui est ouvert sur l’hôte"
      />
      <div className="p-4 md:p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <StickyTabsList>
            <TabsTrigger value="carte">Carte</TabsTrigger>
            <TabsTrigger value="ports">
              Ports ouverts{topology ? ` (${topology.ports.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="reseaux">Réseaux partagés</TabsTrigger>
          </StickyTabsList>
          <TabsContent value="carte" className="pt-4">
            {topology ? <TopologyMap topology={topology} /> : <Skeleton className="h-96 w-full" />}
          </TabsContent>
          <TabsContent value="ports" className="pt-4">
            {topology ? (
              <PortsTable ports={topology.ports} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </TabsContent>
          <TabsContent value="reseaux" className="pt-4">
            <SharedNetworksPanel />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
