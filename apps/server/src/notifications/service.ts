import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import {
  isHostEvent,
  NOTIFICATION_CHANNEL_LABELS,
  notificationGroupOf,
  type ConnectionCheck,
  type NotificationChannelType,
  type SmtpSecurity,
} from '@vercio/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/client.js'
import {
  appSettings,
  notificationChannelProjects,
  notificationChannels,
  notificationDeliveries,
  users,
} from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { buildMessage, clean, digestOf, type NotificationMessage } from './message.js'
import { redactUrls } from './outbound.js'
import {
  renderEmail,
  renderTeams,
  renderWebhookBody,
  webhookHeaders,
  type Content,
} from './render.js'
import { postJson, sendMail, type SendResult, type SmtpConfig } from './senders.js'

type ChannelRow = typeof notificationChannels.$inferSelect
type DeliveryRow = typeof notificationDeliveries.$inferSelect

/** Configuration d'un canal, chiffrée dans `config_enc` (destinataires, URL signée, secret). */
export type ChannelConfig =
  | { type: 'email'; recipients: string[]; allAdmins: boolean }
  | { type: 'teams'; url: string }
  | { type: 'webhook'; url: string; secret: string; allowHttp: boolean }

/** Réglages SMTP (`app_settings` 'smtp'), mot de passe chiffré. */
export interface StoredSmtp {
  host: string
  port: number
  security: SmtpSecurity
  username: string | null
  passwordEnc: string | null
  from: string
  fromName: string
  caCertificate: string | null
  lastCheck: ConnectionCheck | null
}
export const SMTP_SETTINGS_KEY = 'smtp'

export interface EmitOptions {
  /** Anti-spam : un seul message par clé et par fenêtre, les suivants sont comptés sur le premier. */
  dedupeKey?: string
  dedupeWindowMs?: number
  /** Messages d'une même clé (alertes d'un environnement) attendus `GROUP_DELAY_MS` puis groupés. */
  groupKey?: string
  /** Canal exclu : l'alerte sur la panne d'un canal ne passe pas par ce canal. */
  excludeChannelId?: string
}

export interface NotificationServiceOptions {
  /** Adresse publique de Vercio : liens des messages. */
  publicUrl: string
  log: FastifyBaseLogger
  /** Tests et développement : récepteur sur la machine de Vercio. */
  allowLoopback?: boolean
  /** Tests : aucun envoi automatique, la file est relevée par `drain()`. */
  manual?: boolean
}

/** Délais entre deux essais (≈ 4 h au total), avec un aléa de ±20 %. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
const DEDUPE_WINDOW_MS = 15 * 60_000
export const GROUP_DELAY_MS = 30_000
const SEND_LOCK_MS = 2 * 60_000
/** Débit par canal sur 5 min : au-delà, les messages en attente partent en un récapitulatif. */
const RATE_WINDOW_MS = 5 * 60_000
const RATE_LIMITS: Record<NotificationChannelType, number | null> = {
  // Teams limite à 25 publications par 5 min, refusées après le 202 (invisible pour Vercio).
  teams: 20,
  email: 30,
  webhook: null,
}
const MAX_PARALLEL_CHANNELS = 4
/** Une alerte de conteneur qui n'a pas pu partir en 1 h n'a plus d'intérêt. */
const STALE_CONTAINER_MS = 60 * 60_000
/**
 * Canal signalé en panne après 3 échecs définitifs de suite (identifiants, URL), ou après 30 min
 * d'échecs temporaires (serveur injoignable) : une coupure brève ne déclenche pas d'alerte.
 */
const FAILING_AFTER_FAILURES = 3
const FAILING_AFTER_MS = 30 * 60_000
const RETENTION_MS = 30 * 24 * 3600_000
const RETENTION_PER_CHANNEL = 500
const FALLBACK_MAX = 50

function retryDelay(attempts: number, retryAfterMs?: number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!
  const jittered = base * (0.8 + Math.random() * 0.4)
  return Math.max(jittered, Math.min(retryAfterMs ?? 0, 2 * 3600_000))
}

function check(result: SendResult): ConnectionCheck {
  return {
    ok: result.ok,
    message: result.message,
    details: result.statusCode ? [{ label: 'Code', value: String(result.statusCode) }] : [],
    warnings: result.warnings,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Notifications : `emit` enregistre une ligne par canal abonné (file persistante, aucun appel
 * réseau) ; un worker interne envoie, un message à la fois par canal, avec réessais, limite de
 * débit et récapitulatifs. Une seule instance de Vercio par base (verrou pris au démarrage).
 */
export class NotificationService {
  #timer: NodeJS.Timeout | null = null
  #purgeTimer: NodeJS.Timeout | null = null
  #tick: Promise<void> | null = null
  #again = false
  readonly #busy = new Map<string, Promise<void>>()
  /** Alertes de l'hôte non enregistrées (base pleine ou indisponible) : envoyées directement. */
  readonly #fallback: NotificationMessage[] = []

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly options: NotificationServiceOptions,
  ) {}

  /** Vérification des URL de destination (adresse locale permise en test). */
  get outboundOptions(): { allowLoopback: boolean } {
    return { allowLoopback: this.options.allowLoopback ?? false }
  }

  get homeUrl(): string {
    return this.options.publicUrl.replace(/\/$/, '')
  }

  /** Lien vers une page de Vercio. */
  link(path: string): string {
    return `${this.homeUrl}${path}`
  }

  // --- Émission ---------------------------------------------------------------------------

  /**
   * Enregistre le message pour chaque canal abonné. Ne lève jamais d'exception : une
   * notification ne doit pas faire échouer l'opération qu'elle décrit.
   */
  async notify(message: NotificationMessage, options: EmitOptions = {}): Promise<void> {
    try {
      await this.emit(message, options)
    } catch (error) {
      this.options.log.warn({ err: error, event: message.event }, 'Notification non enregistrée')
      if (isHostEvent(message.event) && this.#fallback.length < FALLBACK_MAX) {
        this.#fallback.push(message)
      }
    }
  }

  /** Nombre de canaux visés. */
  async emit(message: NotificationMessage, options: EmitOptions = {}): Promise<number> {
    const channels = await this.matchingChannels(message, options.excludeChannelId)
    if (channels.length === 0) return 0
    const now = Date.now()
    let created = 0
    for (const channel of channels) {
      if (options.dedupeKey) {
        const window = new Date(now - (options.dedupeWindowMs ?? DEDUPE_WINDOW_MS))
        const repeated = await this.db
          .update(notificationDeliveries)
          .set({ suppressedCount: sql`${notificationDeliveries.suppressedCount} + 1` })
          .where(
            and(
              eq(notificationDeliveries.channelId, channel.id),
              eq(notificationDeliveries.dedupeKey, options.dedupeKey),
              gte(notificationDeliveries.createdAt, window),
            ),
          )
          .returning({ id: notificationDeliveries.id })
        if (repeated.length) continue
      }
      await this.db.insert(notificationDeliveries).values({
        channelId: channel.id,
        event: message.event,
        severity: message.severity,
        title: message.title,
        message,
        groupKey: options.groupKey ?? null,
        dedupeKey: options.dedupeKey ?? null,
        createdAt: new Date(now),
        nextAttemptAt: new Date(options.groupKey ? now + GROUP_DELAY_MS : now),
      })
      created++
    }
    if (created) this.poke()
    return created
  }

  /** Canaux actifs abonnés à l'évènement et couvrant son projet et son environnement. */
  private async matchingChannels(
    message: NotificationMessage,
    excludeChannelId?: string,
  ): Promise<ChannelRow[]> {
    if (message.event === 'test') return []
    const group = notificationGroupOf(message.event)
    const host = isHostEvent(message.event)
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.enabled, true))
    const selected = rows.filter((row) => row.projectScope === 'selected').map((row) => row.id)
    const links = selected.length
      ? await this.db
          .select()
          .from(notificationChannelProjects)
          .where(inArray(notificationChannelProjects.channelId, selected))
      : []
    return rows.filter((channel) => {
      if (channel.id === excludeChannelId) return false
      if (group && !channel.groups.includes(group)) return false
      // Évènement de l'instance (hôte, sauvegarde de Vercio) : sans filtre de projet.
      if (host || !message.project) return true
      if (channel.projectScope === 'selected') {
        const projectId = message.project?.id
        if (!projectId) return false
        if (!links.some((link) => link.channelId === channel.id && link.projectId === projectId)) {
          return false
        }
      }
      if (channel.environmentSlugs.length) {
        const slug = message.environment?.slug
        if (!slug || !channel.environmentSlugs.includes(slug)) return false
      }
      return true
    })
  }

  // --- Worker -----------------------------------------------------------------------------

  start(): void {
    if (this.#timer || this.options.manual) return
    this.#timer = setInterval(() => this.poke(), 2000)
    this.#timer.unref()
    this.#purgeTimer = setInterval(() => void this.purge().catch(() => {}), 3600_000)
    this.#purgeTimer.unref()
    this.poke()
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    if (this.#purgeTimer) clearInterval(this.#purgeTimer)
    this.#timer = this.#purgeTimer = null
    await this.#tick
    await Promise.all(this.#busy.values())
  }

  /** Relève la file tout de suite (après un emit, ou à chaque intervalle). */
  poke(): void {
    if (this.options.manual) return
    if (this.#tick) {
      this.#again = true
      return
    }
    this.#tick = this.tick()
      .catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'File des notifications indisponible')
      })
      .finally(() => {
        this.#tick = null
        if (this.#again) {
          this.#again = false
          this.poke()
        }
      })
  }

  /** Envoie tout ce qui est dû, y compris les réessais (tests). */
  async drain(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      await this.tick()
      await Promise.all(this.#busy.values())
      const [due] = await this.db
        .select({ value: count() })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.status, 'pending'),
            lte(notificationDeliveries.nextAttemptAt, new Date()),
          ),
        )
      if (!due?.value && this.#fallback.length === 0) return
    }
  }

  private async tick(): Promise<void> {
    const now = new Date()
    // Envoi interrompu (Vercio arrêté pendant l'envoi) : remis en file.
    await this.db
      .update(notificationDeliveries)
      .set({ status: 'pending', lockedUntil: null })
      .where(
        and(
          eq(notificationDeliveries.status, 'sending'),
          lt(notificationDeliveries.lockedUntil, now),
        ),
      )
    if (this.#fallback.length) await this.flushFallback()
    const due = await this.db
      .selectDistinct({ channelId: notificationDeliveries.channelId })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.status, 'pending'),
          lte(notificationDeliveries.nextAttemptAt, now),
        ),
      )
    for (const { channelId } of due) {
      if (this.#busy.has(channelId) || this.#busy.size >= MAX_PARALLEL_CHANNELS) continue
      const work = this.processChannel(channelId)
        .catch((error: unknown) => {
          this.options.log.warn({ err: error, channelId }, 'Envoi de notification impossible')
        })
        .finally(() => {
          this.#busy.delete(channelId)
        })
      this.#busy.set(channelId, work)
    }
  }

  /** Un envoi pour ce canal : le plus ancien message dû, ou un récapitulatif. */
  private async processChannel(channelId: string): Promise<void> {
    const [channel] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .limit(1)
    if (!channel) return
    const pending = await this.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channelId, channelId),
          eq(notificationDeliveries.status, 'pending'),
        ),
      )
      .orderBy(asc(notificationDeliveries.createdAt))
      .limit(200)
    if (!channel.enabled) {
      await this.finish(pending, { status: 'suppressed', error: 'Canal désactivé' })
      return
    }
    const now = Date.now()
    const due = pending.filter((row) => row.nextAttemptAt.getTime() <= now)
    const head = due[0]
    if (!head) return

    let batch = [head]
    const limit = RATE_LIMITS[channel.type]
    if (limit !== null) {
      if (head.groupKey) batch = pending.filter((row) => row.groupKey === head.groupKey)
      const budget = limit - (await this.sentRecently(channelId, now))
      // Limite atteinte : les messages attendent ; dernier envoi permis : tout part ensemble.
      if (budget <= 0) return
      if (budget === 1 && due.length > batch.length) {
        batch = [...new Set([...batch, ...due])]
      }
    }

    const claimed = await this.db
      .update(notificationDeliveries)
      .set({
        status: 'sending',
        lockedUntil: new Date(now + SEND_LOCK_MS),
        attempts: sql`${notificationDeliveries.attempts} + 1`,
      })
      .where(
        and(
          inArray(
            notificationDeliveries.id,
            batch.map((row) => row.id),
          ),
          eq(notificationDeliveries.status, 'pending'),
        ),
      )
      .returning()
    if (claimed.length === 0) return
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const first = claimed[0]!
    const messages = claimed.map((row) => withRepeats(row))
    const content: Content =
      messages.length === 1
        ? { kind: 'single', message: messages[0]! }
        : { kind: 'digest', ...digestOf(messages, this.homeUrl) }

    let result: SendResult
    try {
      result = await this.send(channel, content, first.id)
    } catch (error) {
      result = {
        ok: false,
        permanent: false,
        message: `Envoi impossible : ${error instanceof Error ? error.message : String(error)}`,
        statusCode: null,
        warnings: [],
      }
    }

    if (result.ok) {
      const sentAt = new Date()
      await this.db
        .update(notificationDeliveries)
        .set({
          status: 'sent',
          sentAt,
          lockedUntil: null,
          statusCode: result.statusCode,
          error: result.warnings.length ? clean(result.warnings.join(' ; '), 1000) : null,
        })
        .where(eq(notificationDeliveries.id, first.id))
      if (claimed.length > 1) {
        await this.db
          .update(notificationDeliveries)
          .set({ status: 'sent', sentAt, lockedUntil: null, mergedIntoId: first.id, error: null })
          .where(
            inArray(
              notificationDeliveries.id,
              claimed.slice(1).map((row) => row.id),
            ),
          )
      }
      await this.channelSucceeded(channel, result)
      return
    }

    const stale =
      claimed.every((row) => row.event.startsWith('container.')) &&
      now - first.createdAt.getTime() > STALE_CONTAINER_MS
    const retry = !result.permanent && first.attempts < MAX_ATTEMPTS && !stale
    await this.db
      .update(notificationDeliveries)
      .set({
        status: retry ? 'pending' : 'failed',
        lockedUntil: null,
        nextAttemptAt: new Date(Date.now() + retryDelay(first.attempts, result.retryAfterMs)),
        statusCode: result.statusCode,
        error: clean(redactUrls(result.message), 1000),
      })
      .where(
        inArray(
          notificationDeliveries.id,
          claimed.map((row) => row.id),
        ),
      )
    await this.channelFailed(channel, result)
  }

  private async sentRecently(channelId: string, now: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channelId, channelId),
          eq(notificationDeliveries.status, 'sent'),
          isNull(notificationDeliveries.mergedIntoId),
          ne(notificationDeliveries.event, 'test'),
          gte(notificationDeliveries.sentAt, new Date(now - RATE_WINDOW_MS)),
        ),
      )
    return row?.value ?? 0
  }

  private async finish(
    rows: DeliveryRow[],
    values: { status: 'suppressed' | 'failed'; error: string },
  ): Promise<void> {
    if (rows.length === 0) return
    await this.db
      .update(notificationDeliveries)
      .set({ ...values, lockedUntil: null })
      .where(
        inArray(
          notificationDeliveries.id,
          rows.map((row) => row.id),
        ),
      )
  }

  // --- Envoi ------------------------------------------------------------------------------

  readConfig(channel: Pick<ChannelRow, 'type' | 'configEnc'>): ChannelConfig {
    return { ...JSON.parse(this.box.decrypt(channel.configEnc)), type: channel.type }
  }

  private async send(channel: ChannelRow, content: Content, deliveryId: string) {
    let config: ChannelConfig
    try {
      config = this.readConfig(channel)
    } catch {
      return permanentFailure(
        'Configuration du canal illisible : la clé VERCIO_SECRET_KEY a-t-elle changé ? Ressaisissez la destination.',
      )
    }
    return this.sendWith(config, content, deliveryId)
  }

  /** Envoi direct, sans file : messages de la file et bouton « Tester ». */
  async sendWith(config: ChannelConfig, content: Content, deliveryId: string): Promise<SendResult> {
    const outbound = { allowLoopback: this.options.allowLoopback ?? false }
    switch (config.type) {
      case 'email': {
        const smtp = await this.smtpConfig()
        if (!smtp) {
          return permanentFailure('Serveur SMTP non configuré (Paramètres → Notifications)')
        }
        return sendMail(smtp, await this.recipients(config), renderEmail(content))
      }
      case 'teams':
        // HTTPS obligatoire, sauf récepteur local de test (allowLoopback).
        return postJson(
          config.url,
          renderTeams(content),
          {},
          { ...outbound, kind: 'teams', allowHttp: outbound.allowLoopback },
        )
      case 'webhook': {
        // Un évènement par appel : le récepteur traite des objets de forme fixe.
        const message = content.kind === 'single' ? content.message : content.items[0]!
        const body = renderWebhookBody(deliveryId, message)
        return postJson(
          config.url,
          body,
          webhookHeaders(deliveryId, message.event, body, config.secret),
          { ...outbound, kind: 'webhook', allowHttp: config.allowHttp },
        )
      }
    }
  }

  /** Adresses saisies, plus celles des administrateurs actifs si demandé. */
  private async recipients(config: Extract<ChannelConfig, { type: 'email' }>): Promise<string[]> {
    const list = new Set(config.recipients)
    if (config.allAdmins) {
      const admins = await this.db
        .select({ email: users.email, roles: users.roles })
        .from(users)
        .where(eq(users.disabled, false))
      for (const admin of admins) {
        if (admin.email && admin.roles.includes('vercio-admin')) {
          list.add(admin.email.toLowerCase())
        }
      }
    }
    return [...list]
  }

  async storedSmtp(): Promise<StoredSmtp | null> {
    const [row] = await this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SMTP_SETTINGS_KEY))
      .limit(1)
    return (row?.value as StoredSmtp | undefined) ?? null
  }

  async smtpConfig(): Promise<SmtpConfig | null> {
    const stored = await this.storedSmtp()
    if (!stored) return null
    return {
      host: stored.host,
      port: stored.port,
      security: stored.security,
      username: stored.username,
      password: stored.passwordEnc ? this.box.decrypt(stored.passwordEnc) : null,
      from: stored.from,
      fromName: stored.fromName,
      caCertificate: stored.caCertificate,
    }
  }

  /** Message de test, envoyé tel qu'un vrai message (même rendu, même expéditeur). */
  testMessage(channelName: string): NotificationMessage {
    return buildMessage({
      event: 'test',
      severity: 'info',
      title: `Test de notification · ${channelName}`,
      summary: 'Ce canal reçoit bien les notifications de Vercio.',
      facts: [{ label: 'Canal', value: channelName }],
      url: this.link('/parametres#notifications'),
      linkLabel: 'Ouvrir les paramètres',
      project: null,
      environment: null,
      incident: null,
    })
  }

  /** Bouton « Tester » : envoi direct, consigné dans le journal du canal enregistré. */
  async test(config: ChannelConfig, channelName: string, channelId?: string): Promise<SendResult> {
    const message = this.testMessage(channelName)
    const deliveryId = randomUUID()
    let result: SendResult
    try {
      result = await this.sendWith(config, { kind: 'single', message }, deliveryId)
    } catch (error) {
      result = permanentFailure(
        `Envoi impossible : ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    result = { ...result, message: redactUrls(result.message) }
    if (channelId) {
      await this.db.insert(notificationDeliveries).values({
        id: deliveryId,
        channelId,
        event: 'test',
        severity: 'info',
        title: message.title,
        message,
        status: result.ok ? 'sent' : 'failed',
        attempts: 1,
        sentAt: result.ok ? new Date() : null,
        statusCode: result.statusCode,
        error: result.ok ? null : clean(result.message, 1000),
      })
      await this.db
        .update(notificationChannels)
        .set({ lastResult: check(result) })
        .where(eq(notificationChannels.id, channelId))
    }
    return result
  }

  // --- Santé des canaux -------------------------------------------------------------------

  private async channelSucceeded(channel: ChannelRow, result: SendResult): Promise<void> {
    await this.db
      .update(notificationChannels)
      .set({
        lastResult: check(result),
        consecutiveFailures: 0,
        failingSince: null,
        failureNotified: false,
      })
      .where(eq(notificationChannels.id, channel.id))
    if (channel.failureNotified) {
      await this.notify(
        buildMessage({
          event: 'notification.channel_recovered',
          severity: 'success',
          title: `Canal de notification rétabli · ${channel.name}`,
          summary: `Les notifications envoyées à « ${channel.name} » partent de nouveau.`,
          facts: [
            { label: 'Canal', value: channel.name },
            { label: 'Type', value: NOTIFICATION_CHANNEL_LABELS[channel.type] },
          ],
          url: this.link('/parametres#notifications'),
          linkLabel: 'Voir les notifications',
          project: null,
          environment: null,
          incident: null,
        }),
        { excludeChannelId: channel.id },
      )
    }
  }

  /** Panne durable : signalée une fois sur les autres canaux. */
  private async channelFailed(channel: ChannelRow, result: SendResult): Promise<void> {
    const failures = channel.consecutiveFailures + 1
    const since = channel.failingSince ?? new Date()
    const signal =
      !channel.failureNotified &&
      ((result.permanent && failures >= FAILING_AFTER_FAILURES) ||
        Date.now() - since.getTime() >= FAILING_AFTER_MS)
    await this.db
      .update(notificationChannels)
      .set({
        lastResult: check({ ...result, message: redactUrls(result.message) }),
        consecutiveFailures: failures,
        failingSince: since,
        ...(signal ? { failureNotified: true } : {}),
      })
      .where(eq(notificationChannels.id, channel.id))
    if (!signal) return
    await this.notify(
      buildMessage({
        event: 'notification.channel_failing',
        severity: 'warning',
        title: `Canal de notification en échec · ${channel.name}`,
        summary: `Les notifications envoyées à « ${channel.name} » échouent : elles n'arrivent plus à leurs destinataires.`,
        facts: [
          { label: 'Canal', value: channel.name },
          { label: 'Type', value: NOTIFICATION_CHANNEL_LABELS[channel.type] },
          { label: 'Échecs de suite', value: String(failures) },
        ],
        details: redactUrls(result.message),
        url: this.link('/parametres#notifications'),
        linkLabel: 'Voir les notifications',
        project: null,
        environment: null,
        incident: null,
      }),
      { excludeChannelId: channel.id },
    )
  }

  // --- Secours et rétention ---------------------------------------------------------------

  /** Alertes de l'hôte non enregistrées : nouvel essai d'enregistrement, sinon envoi direct. */
  private async flushFallback(): Promise<void> {
    const messages = this.#fallback.splice(0)
    for (const message of messages) {
      try {
        await this.emit(message)
        continue
      } catch {
        // Base pleine : envoi direct, sans file ni réessai.
      }
      try {
        for (const channel of await this.matchingChannels(message)) {
          const result = await this.send(channel, { kind: 'single', message }, randomUUID())
          if (!result.ok) {
            this.options.log.warn(
              { channel: channel.name, error: result.message },
              'Alerte de l’hôte non envoyée',
            )
          }
        }
      } catch (error) {
        if (this.#fallback.length < FALLBACK_MAX) this.#fallback.push(message)
        this.options.log.warn({ err: error }, 'Alerte de l’hôte en attente')
      }
    }
  }

  /** Journal : 30 jours et 500 lignes par canal au plus, jamais les messages en attente. */
  async purge(): Promise<void> {
    const done = sql`${notificationDeliveries.status} in ('sent', 'failed', 'suppressed')`
    await this.db
      .delete(notificationDeliveries)
      .where(and(done, lt(notificationDeliveries.createdAt, new Date(Date.now() - RETENTION_MS))))
    await this.db.execute(sql`
      delete from notification_deliveries where id in (
        select id from (
          select id, row_number() over (partition by channel_id order by created_at desc) as rank
          from notification_deliveries where status in ('sent', 'failed', 'suppressed')
        ) ranked where rank > ${RETENTION_PER_CHANNEL}
      )`)
  }
}

function permanentFailure(message: string): SendResult {
  return { ok: false, permanent: true, message, statusCode: null, warnings: [] }
}

/** Les répétitions écartées par l'anti-spam sont annoncées dans le message envoyé. */
function withRepeats(row: DeliveryRow): NotificationMessage {
  const message = row.message as NotificationMessage
  if (!row.suppressedCount) return message
  return {
    ...message,
    facts: [
      ...message.facts,
      { label: 'Répétitions', value: `${row.suppressedCount} de plus en 15 min` },
    ],
  }
}
