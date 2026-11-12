import { and, eq, isNotNull, or } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { RegistryWatchView } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { deployments, environmentSources, environments, webhookEvents } from '../db/schema.js'
import type { DeploymentEngine } from '../deploy/engine.js'
import type { WebhookService } from './service.js'

const TICK_MS = 60_000

interface WatchState {
  at: number
  result: string
  error: boolean
}

/**
 * Surveillance du registry : l'alternative aux webhooks quand GitLab ou GitHub ne peuvent pas
 * joindre Vercio (VPN, réseau interne). À l'intervalle choisi, Vercio relit les images suivies
 * et déploie si l'une a changé, avec les mêmes règles qu'un webhook (verrouillage, un seul
 * déploiement à la fois).
 */
export class RegistryWatcher {
  #timer: NodeJS.Timeout | null = null
  #running = false
  readonly #state = new Map<string, WatchState>()

  constructor(
    private readonly db: Database,
    private readonly engine: DeploymentEngine,
    private readonly webhooks: WebhookService,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
  }

  view(environmentId: string, minutes: number | null): RegistryWatchView {
    const state = this.#state.get(environmentId)
    return {
      minutes,
      lastCheckAt: state ? new Date(state.at).toISOString() : null,
      lastResult: state?.result ?? null,
    }
  }

  /** Environnements dont l'intervalle est écoulé, relus l'un après l'autre. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const rows = await this.db
        .select({ id: environments.id, minutes: environments.registryWatchMinutes })
        .from(environments)
        .where(isNotNull(environments.registryWatchMinutes))
      for (const row of rows) {
        const last = this.#state.get(row.id)
        // Petite marge : un tick qui tombe quelques secondes avant l'échéance la prend quand même.
        if (last && now - last.at < row.minutes! * 60_000 - 5_000) continue
        await this.check(row.id, now)
      }
    } catch (error) {
      this.log.warn({ err: error }, 'Surveillance du registry : relecture impossible')
    } finally {
      this.#running = false
    }
  }

  /** Une relecture ; renvoie le résultat affiché dans l'onglet Webhooks. */
  async check(environmentId: string, now = Date.now()): Promise<string> {
    const previous = this.#state.get(environmentId)
    const done = (result: string, error = false) => {
      this.#state.set(environmentId, { at: now, result, error })
      return result
    }
    try {
      const sources = await this.db
        .select({ mode: environmentSources.mode })
        .from(environmentSources)
        .where(eq(environmentSources.environmentId, environmentId))
      if (!sources.length) return done('Aucune image suivie : rien à surveiller')
      if (sources.every((source) => source.mode === 'locked')) {
        return done('Environnement verrouillé : les nouvelles images ne sont pas déployées')
      }
      const [deployed] = await this.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.environmentId, environmentId),
            or(eq(deployments.status, 'succeeded'), eq(deployments.status, 'running')),
          ),
        )
        .limit(1)
      if (!deployed) return done('Jamais déployé : faites le premier déploiement à la main')

      const message = await this.webhooks.runExclusive(environmentId, async () => {
        if (await this.engine.queued(environmentId)) return 'Un déploiement est déjà en attente'
        this.engine.forgetUpdateCheck(environmentId)
        const comparison = await this.engine.imagesChanged(environmentId)
        const tags = comparison.tags.join(', ')
        if (!comparison.changed) return `Images inchangées (${tags})`
        const deployment = await this.engine.request(environmentId, { trigger: 'watch' })
        const reason = `Nouvelle image détectée (${tags}) : déploiement lancé`
        await this.db.insert(webhookEvents).values({
          environmentId,
          source: 'watch',
          payload: { event: 'surveillance du registry' },
          result: 'deployed',
          reason,
          deploymentId: deployment.id,
        })
        return reason
      })
      return done(message)
    } catch (error) {
      const message = `Relecture du registry impossible : ${error instanceof Error ? error.message : String(error)}`
      // Une seule trace par panne, pas une toutes les minutes.
      if (!previous?.error) {
        this.log.warn({ err: error, environmentId }, 'Surveillance du registry : échec')
        await this.db
          .insert(webhookEvents)
          .values({ environmentId, source: 'watch', result: 'error', reason: message })
          .catch(() => {})
      }
      return done(message, true)
    }
  }

  /** Réglage modifié : prochaine relecture au prochain passage. */
  reset(environmentId: string): void {
    this.#state.delete(environmentId)
  }
}
