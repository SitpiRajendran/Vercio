import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  notificationChannelInputSchema,
  resourceAlertSettingsSchema,
  SMTP_DEFAULT_PORTS,
  smtpSettingsInputSchema,
  smtpTestSchema,
  type ConnectionCheck,
  type NotificationChannelData,
  type NotificationChannelSecret,
  type NotificationChannelView,
  type NotificationDeliveryView,
  type NotificationEvent,
  type NotificationGroup,
  type NotificationSeverity,
  type SmtpSettingsData,
  type SmtpSettingsView,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  appSettings,
  notificationChannelProjects,
  notificationChannels,
  notificationDeliveries,
  projects,
  users,
} from '../db/schema.js'
import { audit } from '../lib/audit.js'
import type { SecretBox } from '../lib/crypto.js'
import { assertOutboundUrl, OutboundUrlError, redactUrl } from '../notifications/outbound.js'
import { renderEmail } from '../notifications/render.js'
import { loadResourceAlertSettings, RESOURCE_SETTINGS_KEY } from '../notifications/resources.js'
import { sendMail, verifySmtp, type SendResult, type SmtpConfig } from '../notifications/senders.js'
import {
  SMTP_SETTINGS_KEY,
  type ChannelConfig,
  type NotificationService,
  type StoredSmtp,
} from '../notifications/service.js'

type ChannelRow = typeof notificationChannels.$inferSelect

const idParams = z.object({ id: z.uuid() })
const channelTestSchema = z.object({ id: z.uuid().optional(), channel: z.unknown() })
const deliveriesQuery = z.object({
  channelId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

/** Secret de signature au format Standard Webhooks. */
function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`
}

function toCheck(result: SendResult): ConnectionCheck {
  return {
    ok: result.ok,
    message: result.message,
    details: [
      ...(result.statusCode ? [{ label: 'Code', value: String(result.statusCode) }] : []),
      ...(result.response ? [{ label: 'Réponse du serveur', value: result.response }] : []),
    ],
    warnings: result.warnings,
    checkedAt: new Date().toISOString(),
  }
}

/** Notifications et serveur SMTP (rôle vercio-admin). */
export const notificationRoutes: FastifyPluginAsync<{
  db: Database
  box: SecretBox
  notifications: NotificationService
}> = async (app, { db, box, notifications }) => {
  app.addHook('preHandler', app.requireRole('vercio-admin'))

  function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
    const result = schema.safeParse(data)
    if (result.success) return result.data
    const issue = result.error.issues[0]
    reply
      .code(400)
      .send({ error: issue?.message ?? 'Requête invalide', field: issue?.path.join('.') })
    return null
  }

  function track(
    request: FastifyRequest,
    action: string,
    target: string,
    details?: Record<string, unknown>,
  ) {
    return audit(db, {
      userId: request.user?.id,
      username: request.user?.username,
      action,
      target,
      ip: request.ip,
      success: true,
      details,
    })
  }

  function isUniqueViolation(error: unknown): boolean {
    const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code
    return code === '23505' || (error as { code?: string })?.code === '23505'
  }

  // --- Saturation CPU et mémoire ------------------------------------------------------------

  app.get('/resource-alerts', async () => loadResourceAlertSettings(db))

  app.put('/resource-alerts', async (request, reply) => {
    const input = parse(resourceAlertSettingsSchema, request.body, reply)
    if (!input) return
    await db
      .insert(appSettings)
      .values({ key: RESOURCE_SETTINGS_KEY, value: input })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: input, updatedAt: new Date() } })
    await track(request, 'settings.resource_alerts.update', 'resource_alerts', input)
    return input
  })

  // --- Serveur SMTP -----------------------------------------------------------------------

  function smtpView(stored: StoredSmtp | null): SmtpSettingsView {
    if (!stored) {
      return {
        configured: false,
        host: '',
        port: SMTP_DEFAULT_PORTS.starttls,
        security: 'starttls',
        username: null,
        hasPassword: false,
        from: '',
        fromName: 'Vercio',
        caCertificate: null,
        lastCheck: null,
      }
    }
    return {
      configured: true,
      host: stored.host,
      port: stored.port,
      security: stored.security,
      username: stored.username,
      hasPassword: Boolean(stored.passwordEnc),
      from: stored.from,
      fromName: stored.fromName,
      caCertificate: stored.caCertificate,
      lastCheck: stored.lastCheck,
    }
  }

  /**
   * Mot de passe à utiliser : celui saisi, sinon celui enregistré, mais seulement vers le même
   * serveur et le même compte (sinon un mot de passe « en écriture seule » partirait ailleurs).
   */
  function smtpPassword(
    input: SmtpSettingsData,
    stored: StoredSmtp | null,
  ): { password: string | null } | { error: string } {
    if (!input.username) return { password: null }
    if (input.password) return { password: input.password }
    if (!stored?.passwordEnc) return { password: null }
    const sameTarget =
      stored.host === input.host &&
      stored.port === input.port &&
      stored.security === input.security &&
      stored.username === input.username
    if (!sameTarget) {
      return { error: 'Ressaisissez le mot de passe : le serveur ou le compte a changé' }
    }
    return { password: box.decrypt(stored.passwordEnc) }
  }

  function smtpConfig(input: SmtpSettingsData, password: string | null): SmtpConfig {
    return {
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username ?? null,
      password,
      from: input.from,
      fromName: input.fromName,
      caCertificate: input.caCertificate ?? null,
    }
  }

  async function saveSmtp(value: StoredSmtp) {
    await db
      .insert(appSettings)
      .values({ key: SMTP_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
  }

  app.get('/smtp', async () => smtpView(await notifications.storedSmtp()))

  app.put('/smtp', async (request, reply) => {
    const input = parse(smtpSettingsInputSchema, request.body, reply)
    if (!input) return
    const stored = await notifications.storedSmtp()
    const password = smtpPassword(input, stored)
    if ('error' in password)
      return reply.code(400).send({ error: password.error, field: 'password' })
    const value: StoredSmtp = {
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username ?? null,
      passwordEnc: password.password ? box.encrypt(password.password) : null,
      from: input.from,
      fromName: input.fromName,
      caCertificate: input.caCertificate ?? null,
      lastCheck: null,
    }
    await saveSmtp(value)
    await track(request, 'settings.smtp.update', input.host, {
      port: input.port,
      security: input.security,
      authentication: Boolean(input.username),
    })
    return smtpView(value)
  })

  app.delete('/smtp', async (request, reply) => {
    await db.delete(appSettings).where(eq(appSettings.key, SMTP_SETTINGS_KEY))
    await track(request, 'settings.smtp.delete', 'smtp')
    return reply.code(204).send()
  })

  /** Test du formulaire : connexion et authentification, puis email de test si `to` est fourni. */
  app.post('/smtp/test', async (request, reply) => {
    const body = parse(smtpTestSchema, request.body, reply)
    const input = body && parse(smtpSettingsInputSchema, body.settings, reply)
    if (!body || !input) return
    const stored = await notifications.storedSmtp()
    const password = smtpPassword(input, stored)
    if ('error' in password)
      return reply.code(400).send({ error: password.error, field: 'password' })
    if (input.username && !password.password) {
      return reply.code(400).send({ error: 'Mot de passe requis', field: 'password' })
    }
    const config = smtpConfig(input, password.password)
    let result = await verifySmtp(config)
    if (result.ok && body.to) {
      const sent = await sendMail(
        config,
        [body.to],
        renderEmail({
          kind: 'single',
          message: notifications.testMessage('Serveur SMTP'),
        }),
      )
      result = sent.ok ? { ...sent, message: `Email de test envoyé à ${body.to}` } : sent
    }
    const check = toCheck(result)
    await track(request, 'settings.smtp.test', input.host, { ok: result.ok, to: body.to ?? null })
    // Résultat gardé si c'est la configuration enregistrée qui a été testée.
    if (
      stored &&
      !input.password &&
      stored.host === input.host &&
      stored.port === input.port &&
      stored.username === (input.username ?? null)
    ) {
      await saveSmtp({ ...stored, lastCheck: check })
    }
    return check
  })

  // --- Canaux -----------------------------------------------------------------------------

  async function channelViews(rows: ChannelRow[]): Promise<NotificationChannelView[]> {
    const ids = rows.map((row) => row.id)
    const links = ids.length
      ? await db
          .select({
            channelId: notificationChannelProjects.channelId,
            id: projects.id,
            name: projects.name,
            slug: projects.slug,
          })
          .from(notificationChannelProjects)
          .innerJoin(projects, eq(projects.id, notificationChannelProjects.projectId))
          .where(inArray(notificationChannelProjects.channelId, ids))
      : []
    return rows.map((row) => {
      let config: ChannelConfig | null = null
      try {
        config = notifications.readConfig(row)
      } catch {
        config = null
      }
      const base: NotificationChannelView = {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        groups: row.groups as NotificationGroup[],
        projectScope: row.projectScope === 'selected' ? 'selected' : 'all',
        projects: links
          .filter((link) => link.channelId === row.id)
          .map(({ id, name, slug }) => ({ id, name, slug })),
        environmentSlugs: row.environmentSlugs,
        target: 'Configuration illisible : ressaisissez la destination',
        email: null,
        teams: null,
        webhook: null,
        lastResult: (row.lastResult as ConnectionCheck | null) ?? null,
        consecutiveFailures: row.consecutiveFailures,
        failingSince: row.failingSince?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }
      if (config?.type === 'email') {
        base.email = { recipients: config.recipients, allAdmins: config.allAdmins }
        base.target = [
          config.recipients.length ? `${config.recipients.length} destinataire(s)` : '',
          config.allAdmins ? 'administrateurs' : '',
        ]
          .filter(Boolean)
          .join(' + ')
      } else if (config?.type === 'teams') {
        // L'URL complète contient la signature du workflow (sig=) : seul l'hôte est montré.
        base.teams = { urlHint: redactUrl(config.url) }
        base.target = base.teams.urlHint
      } else if (config?.type === 'webhook') {
        base.webhook = {
          url: webhookDisplayUrl(config.url),
          hasSecret: Boolean(config.secret),
          allowHttp: config.allowHttp,
        }
        base.target = base.webhook.url
      }
      return base
    })
  }

  async function findChannel(id: string) {
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .limit(1)
    return row ?? null
  }

  async function checkProjects(input: NotificationChannelData): Promise<string | null> {
    if (input.projectScope !== 'selected' || input.projectIds.length === 0) return null
    const found = await db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, input.projectIds))
    return found.length === new Set(input.projectIds).size ? null : 'Projet introuvable'
  }

  /** Configuration à enregistrer : un champ secret vide garde la valeur enregistrée. */
  function mergeConfig(
    input: NotificationChannelData,
    existing: ChannelConfig | null,
  ): ChannelConfig | { error: string; field: string } {
    switch (input.type) {
      case 'email':
        return { type: 'email', recipients: input.recipients, allAdmins: input.allAdmins }
      case 'teams': {
        const url = input.url ?? (existing?.type === 'teams' ? existing.url : undefined)
        if (!url) return { error: 'URL du workflow requise', field: 'url' }
        return { type: 'teams', url }
      }
      case 'webhook': {
        const url = input.url ?? (existing?.type === 'webhook' ? existing.url : undefined)
        if (!url) return { error: 'URL requise', field: 'url' }
        const secret = existing?.type === 'webhook' ? existing.secret : newSigningSecret()
        return { type: 'webhook', url, secret, allowHttp: input.allowHttp }
      }
    }
  }

  /** Destination refusée d'emblée (adresse interdite, HTTP non coché) ; un DNS en panne passe. */
  async function checkDestination(config: ChannelConfig): Promise<string | null> {
    if (config.type === 'email') return null
    try {
      await assertOutboundUrl(config.url, {
        ...notifications.outboundOptions,
        allowHttp:
          config.type === 'webhook'
            ? config.allowHttp
            : notifications.outboundOptions.allowLoopback,
      })
      return null
    } catch (error) {
      if (error instanceof OutboundUrlError && error.permanent) return error.message
      return null
    }
  }

  async function writeProjects(channelId: string, input: NotificationChannelData) {
    await db
      .delete(notificationChannelProjects)
      .where(eq(notificationChannelProjects.channelId, channelId))
    const ids = input.projectScope === 'selected' ? [...new Set(input.projectIds)] : []
    if (ids.length) {
      await db
        .insert(notificationChannelProjects)
        .values(ids.map((projectId) => ({ channelId, projectId })))
    }
  }

  app.get('/notifications/channels', async () => {
    const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.name)
    return channelViews(rows)
  })

  app.post('/notifications/channels', async (request, reply) => {
    const input = parse(notificationChannelInputSchema, request.body, reply)
    if (!input) return
    const projectError = await checkProjects(input)
    if (projectError) return reply.code(400).send({ error: projectError, field: 'projectIds' })
    const config = mergeConfig(input, null)
    if ('error' in config) return reply.code(400).send(config)
    const destinationError = await checkDestination(config)
    if (destinationError) return reply.code(400).send({ error: destinationError, field: 'url' })
    const { type, ...secret } = config
    try {
      const [row] = await db
        .insert(notificationChannels)
        .values({
          name: input.name,
          type,
          configEnc: box.encrypt(JSON.stringify(secret)),
          enabled: input.enabled,
          groups: input.groups,
          projectScope: input.projectScope,
          environmentSlugs: input.environmentSlugs,
        })
        .returning()
      await writeProjects(row!.id, input)
      await track(request, 'settings.notification_channel.create', input.name, {
        type,
        destination: destinationSummary(config),
      })
      const [channel] = await channelViews([row!])
      return reply.code(201).send({
        channel: channel!,
        // Affiché une seule fois : le récepteur s'en sert pour vérifier les signatures.
        secret: config.type === 'webhook' ? config.secret : null,
      } satisfies NotificationChannelSecret)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  app.put('/notifications/channels/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    const input = params && parse(notificationChannelInputSchema, request.body, reply)
    if (!params || !input) return
    const existing = await findChannel(params.id)
    if (!existing) return reply.code(404).send({ error: 'Canal introuvable' })
    if (existing.type !== input.type) {
      return reply.code(400).send({ error: 'Le type d’un canal ne change pas', field: 'type' })
    }
    const projectError = await checkProjects(input)
    if (projectError) return reply.code(400).send({ error: projectError, field: 'projectIds' })
    let current: ChannelConfig | null = null
    try {
      current = notifications.readConfig(existing)
    } catch {
      current = null
    }
    const config = mergeConfig(input, current)
    if ('error' in config) return reply.code(400).send(config)
    const destinationError = await checkDestination(config)
    if (destinationError) return reply.code(400).send({ error: destinationError, field: 'url' })
    const secret = storedConfig(config)
    const destinationChanged =
      destinationSummary(config) !== (current && destinationSummary(current))
    try {
      const [row] = await db
        .update(notificationChannels)
        .set({
          name: input.name,
          configEnc: box.encrypt(JSON.stringify(secret)),
          enabled: input.enabled,
          groups: input.groups,
          projectScope: input.projectScope,
          environmentSlugs: input.environmentSlugs,
          // Nouvelle destination : l'historique de pannes repart de zéro.
          ...(destinationChanged || ('url' in input && input.url)
            ? {
                lastResult: null,
                consecutiveFailures: 0,
                failingSince: null,
                failureNotified: false,
              }
            : {}),
        })
        .where(eq(notificationChannels.id, params.id))
        .returning()
      await writeProjects(row!.id, input)
      await track(request, 'settings.notification_channel.update', input.name, {
        type: input.type,
        destination: destinationSummary(config),
        enabled: input.enabled,
      })
      const [channel] = await channelViews([row!])
      return channel
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  app.delete('/notifications/channels/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const existing = await findChannel(params.id)
    if (!existing) return reply.code(404).send({ error: 'Canal introuvable' })
    await db.delete(notificationChannels).where(eq(notificationChannels.id, params.id))
    await track(request, 'settings.notification_channel.delete', existing.name)
    return reply.code(204).send()
  })

  /** Nouveau secret de signature (fuite, rotation) : l'ancien cesse aussitôt d'être utilisé. */
  app.post('/notifications/channels/:id/regenerate-secret', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const existing = await findChannel(params.id)
    if (!existing) return reply.code(404).send({ error: 'Canal introuvable' })
    if (existing.type !== 'webhook') {
      return reply.code(400).send({ error: 'Seul un webhook sortant a un secret de signature' })
    }
    let current: ChannelConfig
    try {
      current = notifications.readConfig(existing)
    } catch {
      return reply.code(409).send({ error: 'Configuration illisible : ressaisissez l’URL' })
    }
    if (current.type !== 'webhook') return reply.code(409).send({ error: 'Configuration invalide' })
    const secret = newSigningSecret()
    const [row] = await db
      .update(notificationChannels)
      .set({ configEnc: box.encrypt(JSON.stringify(storedConfig({ ...current, secret }))) })
      .where(eq(notificationChannels.id, existing.id))
      .returning()
    await track(request, 'settings.notification_channel.regenerate_secret', existing.name)
    const [channel] = await channelViews([row!])
    return { channel: channel!, secret } satisfies NotificationChannelSecret
  })

  /** Test du formulaire, avant enregistrement : un champ secret vide garde la valeur enregistrée. */
  app.post('/notifications/channels/test', async (request, reply) => {
    const body = parse(channelTestSchema, request.body, reply)
    const input = body && parse(notificationChannelInputSchema, body.channel, reply)
    if (!body || !input) return
    const existing = body.id ? await findChannel(body.id) : null
    let current: ChannelConfig | null = null
    if (existing && existing.type === input.type) {
      try {
        current = notifications.readConfig(existing)
      } catch {
        current = null
      }
    }
    const config = mergeConfig(input, current)
    if ('error' in config) return reply.code(400).send(config)
    const result = await notifications.test(config, input.name)
    await track(request, 'settings.notification_channel.test', input.name, {
      type: input.type,
      ok: result.ok,
    })
    return toCheck(result)
  })

  app.post('/notifications/channels/:id/test', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const existing = await findChannel(params.id)
    if (!existing) return reply.code(404).send({ error: 'Canal introuvable' })
    let config: ChannelConfig
    try {
      config = notifications.readConfig(existing)
    } catch {
      return reply
        .code(409)
        .send({ error: 'Configuration illisible : ressaisissez la destination' })
    }
    const result = await notifications.test(config, existing.name, existing.id)
    await track(request, 'settings.notification_channel.test', existing.name, {
      type: existing.type,
      ok: result.ok,
    })
    return toCheck(result)
  })

  // --- Journal ----------------------------------------------------------------------------

  app.get('/notifications/deliveries', async (request, reply) => {
    const query = parse(deliveriesQuery, request.query, reply)
    if (!query) return
    const rows = await db
      .select({ delivery: notificationDeliveries, channelName: notificationChannels.name })
      .from(notificationDeliveries)
      .innerJoin(
        notificationChannels,
        eq(notificationChannels.id, notificationDeliveries.channelId),
      )
      .where(
        query.channelId ? and(eq(notificationDeliveries.channelId, query.channelId)) : undefined,
      )
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(query.limit)
    return rows.map(({ delivery, channelName }): NotificationDeliveryView => ({
      id: delivery.id,
      channelId: delivery.channelId,
      channelName,
      event: delivery.event as NotificationEvent,
      severity: delivery.severity as NotificationSeverity,
      title: delivery.title,
      status: delivery.status,
      attempts: delivery.attempts,
      merged: Boolean(delivery.mergedIntoId),
      suppressedCount: delivery.suppressedCount,
      error: delivery.error,
      statusCode: delivery.statusCode,
      createdAt: delivery.createdAt.toISOString(),
      sentAt: delivery.sentAt?.toISOString() ?? null,
      nextAttemptAt: delivery.status === 'pending' ? delivery.nextAttemptAt.toISOString() : null,
    }))
  })

  /** Adresse proposée pour l'email de test : celle de l'administrateur connecté. */
  app.get('/notifications/me', async (request) => {
    const [user] = request.user
      ? await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, request.user.id))
          .limit(1)
      : []
    return { email: user?.email ?? null }
  })
}

/** Configuration chiffrée en base : le type est déjà une colonne. */
function storedConfig(config: ChannelConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'type'))
}

/** URL d'un webhook sans sa chaîne de requête (souvent un jeton). */
function webhookDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}${parsed.search ? '?…' : ''}`
  } catch {
    return '(URL invalide)'
  }
}

/** Résumé de destination pour le journal d'audit : jamais l'URL complète ni les adresses. */
function destinationSummary(config: ChannelConfig): string {
  switch (config.type) {
    case 'email':
      return `${config.recipients.length} adresse(s)${config.allAdmins ? ' + administrateurs' : ''}`
    case 'teams':
      return redactUrl(config.url)
    case 'webhook':
      return webhookDisplayUrl(config.url)
  }
}
