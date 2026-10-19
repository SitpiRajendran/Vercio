import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { EnvironmentRef, SharedNetworkView } from '@vercio/shared'
import { api } from '@/lib/api'

export function useSharedNetworks() {
  return useQuery({ queryKey: ['networks'], queryFn: api.networks.list })
}

export function envLabel(ref: EnvironmentRef): string {
  return `${ref.projectName} / ${ref.environmentName}`
}

/**
 * Réseaux exposés par un environnement (ou un de ses services) et utilisés par d'autres :
 * ce qui casse si on l'arrête ou le supprime.
 */
export function dependentsOf(
  networks: SharedNetworkView[] | undefined,
  environmentIds: string[],
  service?: string,
): SharedNetworkView[] {
  return (networks ?? []).filter(
    (network) =>
      environmentIds.includes(network.exposedBy.environmentId) &&
      (!service || network.exposedBy.service === service) &&
      network.subscribers.some((subscriber) => !environmentIds.includes(subscriber.environmentId)),
  )
}

/** Avertissement avant d'arrêter ou supprimer un service dont d'autres projets dépendent. */
export function DependencyWarning({
  networks,
  environmentIds,
  service,
  action,
}: {
  networks: SharedNetworkView[] | undefined
  environmentIds: string[]
  service?: string
  /** « l'arrêt », « la suppression »… */
  action: string
}) {
  const dependents = dependentsOf(networks, environmentIds, service)
  if (!dependents.length) return null
  return (
    <div className="border-warning/40 bg-warning/10 space-y-1.5 rounded-md border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="text-warning size-4 shrink-0" />
        D’autres projets en dépendent
      </p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
        {dependents.map((network) => {
          const others = network.subscribers.filter(
            (subscriber) => !environmentIds.includes(subscriber.environmentId),
          )
          return (
            <li key={network.id}>
              <code>{network.exposedBy.service}</code> (alias <code>{network.alias}</code>, réseau{' '}
              {network.name}) est utilisé par {others.map(envLabel).join(', ')} : {action} les
              privera de ce service.
            </li>
          )
        })}
      </ul>
    </div>
  )
}
