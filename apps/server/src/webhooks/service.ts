import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type {
  NotificationEvent,
  NotificationSeverity,
  WebhookKind,
  WebhookResponse,
  WebhookResult,
  WebhookSettings,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  appSettings,
  appSources,
  environmentSources,
  environments,
  projects,
  webhookEvents,
} from '../db/schema.js'
import type { DeploymentEngine } from '../deploy/engine.js'
import { hashToken, randomToken, type SecretBox } from '../lib/crypto.js'
import { ipAllowed } from '../lib/ip.js'
import { buildMessage } from '../notifications/message.js'
import type { NotificationService } from '../notifications/service.js'
import type { VersionService } from '../versions/service.js'
import { parseBody, parseEvent, WebhookPayloadError, type WebhookEvent } from './events.js'

export const WEBHOOK_SETTINGS_KEY = 'webhooks'

/** Jeton d'URL et secret de signature d'un couple environnement / source. */
export function newWebhookCredentials(box: SecretBox) {
  const token = randomToken()
  return {
    webhookTokenHash: hashToken(token),
    webhookTokenEnc: box.encrypt(token),
    webhookSecretEnc: box.encrypt(randomToken()),
  }
}

export async function webhookSettings(db: Database): Promise<WebhookSettings> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_SETTINGS_KEY))
    .limit(1)
  const value = (row?.value ?? {}) as Partial<WebhookSettings>
  return { enabled: value.enabled ?? true, ipAllowlist: (value.ipAllowlist ?? []).slice() }
}

export async function globalIpAllowlist(db: Database): Promise<string[]> {
  return (await webhookSettings(db)).ipAllowlist
}

export interface WebhookCall {
  kind: WebhookKind
  token: string
  ip: string
  headers: Record<string, string | string[] | undefined>
  rawBody: Buffer | undefined
}

export interface WebhookOutcome extends WebhookResponse {
  statusCode: number
}

/** Compare deux chaînes en temps constant (empreintes de même longueur). */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

function header(headers: WebhookCall['headers'], name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Traitement d'un appel de webhook. L'appel ne transporte aucune instruction : il déclenche
 * seulement une relecture du registry, et un redéploiement si l'image suivie a changé.
 */
export class WebhookService {
  /** Appels traités l'un après l'autre par environnement : deux appels simultanés ne lancent qu'un déploiement. */
  readonly #locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly engine: DeploymentEngine,
    private readonly versions: VersionService,
    private readonly log: FastifyBaseLogger,
    private readonly notifications?: NotificationService,
  ) {}

  /** Webhooks activés pour l'instance (réglage global). */
  async enabled(): Promise<boolean> {
    return (await webhookSettings(this.db)).enabled
  }

  async handle(call: WebhookCall): Promise<WebhookOutcome> {
    const [target] = await this.db
      .select({
        envSource: environmentSources,
        environment: environments,
        project: projects,
        source: appSources,
      })
      .from(environmentSources)
      .innerJoin(environments, eq(environments.id, environmentSources.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .innerJoin(appSources, eq(appSources.id, environmentSources.appSourceId))
      .where(eq(environmentSources.webhookTokenHash, hashToken(call.token)))
      .limit(1)
    if (!target) {
      return { statusCode: 404, result: 'rejected', message: 'Webhook inconnu', deploymentId: null }
    }
    const { envSource, environment, project, source } = target
    const KIND_LABELS: Record<WebhookKind, string> = {
      generic: 'Générique',
      gitlab: 'GitLab',
      github: 'GitHub',
    }

    /** Alerte, au plus une par type, environnement et source toutes les 15 min (compteur ensuite). */
    const alert = async (
      event: NotificationEvent,
      severity: NotificationSeverity,
      title: string,
      summary: string,
      extra: { ref?: string | null; details?: string } = {},
    ) => {
      if (!this.notifications) return
      await this.notifications.notify(
        buildMessage({
          event,
          severity,
          title: `${title} · ${project.name} / ${environment.name}`,
          summary,
          facts: [
            { label: 'Source', value: source.name },
            { label: 'Webhook', value: KIND_LABELS[call.kind] },
            { label: 'Référence', value: extra.ref ?? '' },
            { label: 'Adresse IP', value: event === 'webhook.rejected' ? call.ip : '' },
          ],
          details: extra.details ?? null,
          url: this.notifications.link(
            `/projets/${project.slug}?onglet=webhooks&env=${environment.slug}`,
          ),
          linkLabel: 'Voir les webhooks',
          project: { id: project.id, slug: project.slug, name: project.name },
          environment: { id: environment.id, slug: environment.slug, name: environment.name },
          incident: null,
          data: { appSourceId: source.id, webhook: call.kind, ref: extra.ref ?? null },
        }),
        { dedupeKey: `${event}:${environment.id}:${source.id}` },
      )
    }

    let details: Record<string, string | null> | null = null
    const finish = async (
      statusCode: number,
      result: WebhookResult,
      message: string,
      deploymentId: string | null = null,
    ): Promise<WebhookOutcome> => {
      if (result === 'rejected') {
        await alert('webhook.rejected', 'warning', 'Appel de webhook refusé', message)
      } else if (result === 'error') {
        await alert(
          'webhook.failed',
          'critical',
          'Nouveau build non vérifié',
          'La relecture du registry a échoué : aucun déploiement n’a été lancé.',
          { details: message },
        )
      }
      await this.db.insert(webhookEvents).values({
        environmentId: environment.id,
        appSourceId: source.id,
        source: call.kind,
        ip: call.ip,
        payload: details,
        result,
        reason: message,
        deploymentId,
      })
      return { statusCode, result, message, deploymentId }
    }

    // 1. Origine : liste de l'environnement, sinon liste globale.
    const allowlist = environment.webhookIpAllowlist.length
      ? environment.webhookIpAllowlist
      : await globalIpAllowlist(this.db)
    if (!ipAllowed(call.ip, allowlist)) {
      return finish(403, 'rejected', `Adresse ${call.ip} non autorisée`)
    }

    // 2. Authenticité des webhooks natifs.
    const secret = envSource.webhookSecretEnc ? this.box.decrypt(envSource.webhookSecretEnc) : null
    if (call.kind === 'gitlab') {
      const provided = header(call.headers, 'x-gitlab-token')
      if (!secret || !provided || !safeEqual(provided, secret)) {
        return finish(401, 'rejected', 'En-tête X-Gitlab-Token absent ou invalide')
      }
    }
    if (call.kind === 'github') {
      const signature = header(call.headers, 'x-hub-signature-256')
      const expected =
        secret &&
        `sha256=${createHmac('sha256', secret)
          .update(call.rawBody ?? '')
          .digest('hex')}`
      if (!expected || !signature || !safeEqual(signature, expected)) {
        return finish(401, 'rejected', 'Signature X-Hub-Signature-256 absente ou invalide')
      }
    }

    // L'URL générique n'a pas de signature : une fois que le dépôt envoie des webhooks signés
    // (ou que Vercio les a créés chez le fournisseur), elle ne doit plus permettre de les
    // contourner (déployer avant la fin d'une pipeline, par exemple).
    if (call.kind === 'generic') {
      const [signed] = envSource.webhookInstalledAt
        ? [{ id: 'installé' }]
        : await this.db
            .select({ id: webhookEvents.id })
            .from(webhookEvents)
            .where(
              and(
                eq(webhookEvents.environmentId, environment.id),
                eq(webhookEvents.appSourceId, source.id),
                inArray(webhookEvents.source, ['gitlab', 'github']),
                ne(webhookEvents.result, 'rejected'),
              ),
            )
            .limit(1)
      if (signed) {
        return finish(
          403,
          'rejected',
          'Ce dépôt envoie des webhooks GitLab ou GitHub signés : l’URL générique est refusée',
        )
      }
    }

    // 3. Contenu de l'appel.
    let event: WebhookEvent
    try {
      event = parseEvent(
        call.kind,
        call.headers,
        parseBody(call.rawBody, header(call.headers, 'content-type')),
      )
    } catch (error) {
      if (error instanceof WebhookPayloadError) return finish(400, 'rejected', error.message)
      throw error
    }
    details = event.details

    // Un nouveau build ou un nouveau tag : la liste des versions affichée doit être relue.
    this.versions.invalidate(source.id)

    if (!event.relevant) return finish(200, 'ignored', event.reason ?? 'Appel sans effet')

    // 4. Branche : un build d'une autre branche ne concerne pas cet environnement.
    if (event.ref && event.ref !== envSource.branch) {
      const isTag = event.isTag ?? safeRegExp(source.tagPattern)?.test(event.ref) ?? false
      if (!isTag) {
        return finish(
          200,
          'ignored',
          `Branche ${event.ref} non suivie (l’environnement suit ${envSource.branch})`,
        )
      }
    }

    // 5. Verrouillage.
    if (envSource.mode === 'locked') {
      const locked = envSource.ref === 'latest' ? `latest (${envSource.branch})` : envSource.ref
      await alert(
        'webhook.ignored',
        'info',
        'Nouveau build ignoré',
        `${environment.name} est verrouillé sur ${locked} : le nouveau build n’est pas déployé.`,
        { ref: event.ref },
      )
      return finish(
        200,
        'ignored',
        `Environnement verrouillé sur ${envSource.ref === 'latest' ? `latest (${envSource.branch})` : envSource.ref}`,
      )
    }

    return this.serialized(environment.id, () => this.deployIfChanged(environment.id, finish))
  }

  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.#locks.set(key, next)
    void next
      .finally(() => {
        if (this.#locks.get(key) === next) this.#locks.delete(key)
      })
      .catch(() => {})
    return next
  }

  private async deployIfChanged(
    environmentId: string,
    finish: (
      statusCode: number,
      result: WebhookResult,
      message: string,
      deploymentId?: string | null,
    ) => Promise<WebhookOutcome>,
  ): Promise<WebhookOutcome> {
    // 6. Déploiement déjà en attente : il lira lui-même les dernières images.
    const queued = await this.engine.queued(environmentId)
    if (queued) return finish(200, 'merged', 'Un déploiement est déjà en attente', queued)

    // 7. Relecture du registry : on ne redéploie que si une image a changé.
    let comparison: Awaited<ReturnType<DeploymentEngine['imagesChanged']>>
    try {
      comparison = await this.engine.imagesChanged(environmentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn({ err: error, environmentId }, 'Webhook : relecture impossible')
      return finish(502, 'error', `Relecture du registry impossible : ${message}`)
    }
    if (!comparison.changed) {
      return finish(
        200,
        'unchanged',
        `Images inchangées (${comparison.tags.join(', ')}) : rien à déployer`,
      )
    }
    const deployment = await this.engine.request(environmentId, { trigger: 'webhook' })
    return finish(
      202,
      'deployed',
      `Nouvelle image détectée (${comparison.tags.join(', ')}) : déploiement lancé`,
      deployment.id,
    )
  }
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}
