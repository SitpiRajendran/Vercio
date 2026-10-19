import type {
  ContainerView,
  OverviewEnvironment,
  OverviewProject,
  PublishedPort,
  SharedNetworkView,
} from '@vercio/shared'

/** Conteneur placé sur la carte, avec son projet et son environnement. */
export interface MapContainer {
  container: ContainerView
  project: OverviewProject
  env: OverviewEnvironment
}

export interface MapGroup {
  project: OverviewProject
  env: OverviewEnvironment
  /** Plusieurs environnements dans le projet : le nom de l'environnement est affiché. */
  showEnv: boolean
  containers: ContainerView[]
  /** Réseaux internes du projet Compose (nom Docker → nom court). */
  networks: { name: string; label: string }[]
}

export interface MapPort {
  item: MapContainer
  port: PublishedPort
  /** Ouvert sur toutes les interfaces (accessible de l'extérieur). */
  public: boolean
}

/** Ce qu'un conteneur peut joindre ou ce qui le joint, en phrases courtes. */
export interface Link {
  kind: 'internal' | 'shared-out' | 'shared-in' | 'depends' | 'port'
  text: string
  /** Conteneur à l'autre bout, s'il est sur la carte. */
  peer?: string
}

export interface Topology {
  groups: MapGroup[]
  shared: SharedNetworkView[]
  ports: MapPort[]
  byId: Map<string, MapContainer>
  links: (containerId: string) => Link[]
}

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost'])

export const isPublicPort = (port: PublishedPort) => !port.ip || !LOCAL_ADDRESSES.has(port.ip)

/** Nom court d'un réseau Compose : `vercio_site_prod_interne` → `interne`. */
function networkLabel(name: string, composeProject: string) {
  return name.startsWith(`${composeProject}_`) ? name.slice(composeProject.length + 1) : name
}

/**
 * Qui parle à qui : réseaux internes de chaque projet, réseaux partagés entre projets,
 * dépendances de démarrage et ports publiés sur l'hôte.
 * `focus` : environnements à montrer (plus ceux qui leur sont reliés par un réseau partagé).
 */
export function buildTopology(
  projects: OverviewProject[],
  sharedNetworks: SharedNetworkView[],
  focus?: string[],
): Topology {
  let envIds: Set<string> | null = null
  let shared = sharedNetworks
  if (focus) {
    envIds = new Set(focus)
    shared = sharedNetworks.filter(
      (network) =>
        focus.includes(network.exposedBy.environmentId) ||
        network.subscribers.some((subscriber) => focus.includes(subscriber.environmentId)),
    )
    for (const network of shared) {
      envIds.add(network.exposedBy.environmentId)
      for (const subscriber of network.subscribers) envIds.add(subscriber.environmentId)
    }
  }

  const groups: MapGroup[] = []
  const byId = new Map<string, MapContainer>()
  const sharedNames = new Set(sharedNetworks.map((network) => network.dockerName))
  for (const project of projects) {
    for (const env of project.environments) {
      if (envIds && !envIds.has(env.id)) continue
      if (env.containers.length === 0) continue
      const internal = new Set<string>()
      for (const container of env.containers) {
        byId.set(container.id, { container, project, env })
        for (const name of container.networks) if (!sharedNames.has(name)) internal.add(name)
      }
      groups.push({
        project,
        env,
        showEnv: project.environments.length > 1,
        containers: env.containers,
        networks: [...internal]
          .sort()
          .map((name) => ({ name, label: networkLabel(name, env.composeProject) })),
      })
    }
  }

  const ports: MapPort[] = []
  for (const item of byId.values()) {
    for (const port of item.container.published) {
      ports.push({ item, port, public: isPublicPort(port) })
    }
  }
  ports.sort((a, b) => a.port.hostPort - b.port.hostPort)

  const links = (containerId: string): Link[] => {
    const self = byId.get(containerId)
    if (!self) return []
    const result: Link[] = []
    const { container, env } = self
    for (const port of container.published) {
      result.push({
        kind: 'port',
        text: isPublicPort(port)
          ? `Ouvert à tous sur le port ${port.hostPort} de l’hôte (→ ${port.containerPort} dans le conteneur)`
          : `Joignable depuis l’hôte seulement, sur ${port.ip}:${port.hostPort} (→ ${port.containerPort})`,
      })
    }
    for (const name of container.networks) {
      const network = sharedNetworks.find((item) => item.dockerName === name)
      if (network) {
        const exposer =
          network.exposedBy.environmentId === env.id &&
          network.exposedBy.service === container.service
        if (exposer) {
          const users = network.subscribers.map(
            (subscriber) => `${subscriber.projectName} (${subscriber.environmentName})`,
          )
          result.push({
            kind: 'shared-in',
            text: `Exposé sous le nom « ${network.alias} » ${users.length ? `à ${users.join(', ')}` : '(aucun abonné)'}`,
          })
        } else {
          const peer = [...byId.values()].find(
            (item) =>
              item.env.id === network.exposedBy.environmentId &&
              item.container.service === network.exposedBy.service,
          )
          result.push({
            kind: 'shared-out',
            text: `Joint « ${network.alias} » : ${network.exposedBy.service} de ${network.exposedBy.projectName} (${network.exposedBy.environmentName})`,
            peer: peer?.container.id,
          })
        }
        continue
      }
      const label = networkLabel(name, env.composeProject)
      for (const other of env.containers) {
        if (other.id === container.id || !other.networks.includes(name)) continue
        result.push({
          kind: 'internal',
          text: `Joint « ${other.service} » par son nom (réseau ${label})`,
          peer: other.id,
        })
      }
    }
    for (const service of container.dependsOn) {
      const peer = env.containers.find((item) => item.service === service)
      result.push({ kind: 'depends', text: `Démarre après « ${service} »`, peer: peer?.id })
    }
    return result
  }

  return { groups, shared, ports, byId, links }
}

/** Couleurs des réseaux internes d'un projet (pastilles), dans l'ordre. */
export const NETWORK_COLORS = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-teal-500',
]
