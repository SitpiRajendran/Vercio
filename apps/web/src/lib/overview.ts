import { useQuery } from '@tanstack/react-query'
import type { ContainerView, OverviewEnvironment, OverviewView } from '@vercio/shared'
import { api } from '@/lib/api'

export type Tone = 'ok' | 'warning' | 'error' | 'stopped' | 'busy'

/** Tous les projets et leurs conteneurs (accueil, barre latérale, recherche). */
export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: api.overview.get,
    refetchInterval: 5000,
    select: mergeRelays,
  })
}

/**
 * Relais des services mis à jour sans coupure : masqués, leurs ports publiés affichés sur le
 * service qu'ils relaient (c'est par eux qu'on atteint le service).
 */
export function mergeRelays(view: OverviewView): OverviewView {
  return {
    ...view,
    projects: view.projects.map((project) => ({
      ...project,
      environments: project.environments.map((env) => {
        const relays = env.containers.filter((container) => container.relayFor)
        if (!relays.length) return env
        return {
          ...env,
          containers: env.containers
            .filter((container) => !container.relayFor)
            .map((container) => {
              const relay = relays.find((item) => item.relayFor === container.service)
              return relay
                ? {
                    ...container,
                    ports: [...container.ports, ...relay.ports],
                    published: [...container.published, ...relay.published],
                  }
                : container
            }),
        }
      }),
    })),
  }
}

/** Consommation des conteneurs en marche, indexée par identifiant. */
export function useUsage(enabled = true) {
  return useQuery({
    queryKey: ['overview', 'usage'],
    queryFn: api.overview.usage,
    refetchInterval: 5000,
    enabled,
    retry: false,
    select: (list) => new Map(list.map((item) => [item.id, item])),
  })
}

/** Code de sortie lu dans le statut Docker : « Exited (137) 2 minutes ago ». */
export function exitCode(container: Pick<ContainerView, 'status'>): number | null {
  const match = /Exited \((\d+)\)/.exec(container.status)
  return match ? Number(match[1]) : null
}

/** Arrêts normaux : demandé (0), SIGTERM (143), SIGKILL après délai (137). */
const NORMAL_EXITS = new Set([0, 137, 143])

export function containerStatus(container: ContainerView): { tone: Tone; label: string } {
  const { state, health } = container
  if (state === 'running') {
    if (health === 'unhealthy') return { tone: 'error', label: 'Ne répond plus' }
    if (health === 'starting') return { tone: 'warning', label: 'Démarrage' }
    return { tone: 'ok', label: 'En marche' }
  }
  if (state === 'restarting') return { tone: 'error', label: 'Redémarre en boucle' }
  if (state === 'dead') return { tone: 'error', label: 'Hors service' }
  if (state === 'paused') return { tone: 'stopped', label: 'En pause' }
  if (state === 'created') return { tone: 'warning', label: 'Jamais démarré' }
  if (state === 'exited') {
    const code = exitCode(container)
    if (code !== null && !NORMAL_EXITS.has(code)) {
      return { tone: 'error', label: `Planté (code ${code})` }
    }
    return { tone: 'stopped', label: 'Arrêté' }
  }
  return { tone: 'stopped', label: state }
}

export const isRunning = (container: ContainerView) =>
  container.state === 'running' || container.state === 'restarting'

/** État résumé d'un environnement, pour une pastille et une phrase. */
export function environmentStatus(env: OverviewEnvironment): { tone: Tone; label: string } {
  const last = env.lastDeployment
  if (last && (last.status === 'queued' || last.status === 'running')) {
    return { tone: 'busy', label: 'Déploiement en cours' }
  }
  const containers = env.containers
  if (containers.length === 0) {
    if (last?.status === 'failed') return { tone: 'error', label: 'Déploiement échoué' }
    return { tone: 'stopped', label: env.current ? 'Aucun conteneur' : 'Jamais déployé' }
  }
  const tones = containers.map((container) => containerStatus(container).tone)
  const running = containers.filter((container) => container.state === 'running').length
  if (tones.includes('error')) {
    const count = tones.filter((tone) => tone === 'error').length
    return { tone: 'error', label: `${count} service${count > 1 ? 's' : ''} en erreur` }
  }
  if (running === 0) return { tone: 'stopped', label: 'Arrêté' }
  if (last?.status === 'failed') return { tone: 'warning', label: 'Dernier déploiement échoué' }
  const saturated = env.alerts.filter((alert) => alert.active)
  if (saturated.length) {
    return {
      tone: 'warning',
      label: `Consommation élevée (${saturated.map((alert) => alert.service).join(', ')})`,
    }
  }
  if (tones.includes('warning') || running < containers.length) {
    return { tone: 'warning', label: `${running} sur ${containers.length} en marche` }
  }
  return { tone: 'ok', label: `${running} en marche` }
}

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
  stopped: 'bg-muted-foreground/40',
  busy: 'bg-chart animate-pulse',
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  stopped: 'text-muted-foreground',
  busy: 'text-chart',
}
