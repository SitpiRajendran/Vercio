import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  hasRole,
  ipAllowlistSchema,
  webhookSettingsInputSchema,
  type WebhookConfigView,
  type WebhookEventView,
  type WebhookKind,
  type WebhookResult,
  type WebhookSettings,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  appSettings,
  appSources,
  environmentSources,
  environments,
  gitProviders,
  projects,
  webhookEvents,
} from '../db/schema.js'
import { WebhookInstallError } from '../providers/git.js'
import { installRemoteWebhook } from '../webhooks/remote.js'
import type { SecretBox } from '../lib/crypto.js'
import {
  webhookSettings,
  newWebhookCredentials,
  WEBHOOK_SETTINGS_KEY,
  type WebhookService,
} from '../webhooks/service.js'
import { auditAction, parseInput } from './helpers.js'

/**
 * Points d'entrée publics des webhooks : `POST /api/hooks/<jeton>` (générique),
 * `/api/hooks/gitlab/<jeton>` et `/api/hooks/github/<jeton>`.
 */
export const hookRoutes: FastifyPluginAsync<{ webhooks: WebhookService }> = async (
  app,
  { webhooks },
) => {
  // Corps brut : la signature GitHub porte sur les octets reçus, pas sur le JSON relu.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

  const options = {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }
  const params = z.object({ token: z.string().min(16).max(128) })

  const handle = (kind: WebhookKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseInput(params, request.params, reply)
    if (!input) return
    // Désactivés : même réponse qu'une route inconnue, rien n'est journalisé ni déclenché.
    if (!(await webhooks.enabled())) return reply.code(404).send({ error: 'Route inconnue' })
    const { statusCode, ...response } = await webhooks.handle({
      kind,
      token: input.token,
      ip: request.ip,
      headers: request.headers,
      rawBody: Buffer.isBuffer(request.body) ? request.body : undefined,
    })
    return reply.code(statusCode).send(response)
  }

  app.post('/:token', options, handle('generic'))
  app.post('/gitlab/:token', options, handle('gitlab'))
  app.post('/github/:token', options, handle('github'))
}

/** Configuration des webhooks d'un environnement, et liste d'IP globale. */
export const webhookAdminRoutes: FastifyPluginAsync<{
  db: Database
  box: SecretBox
  publicUrl: URL
}> = async (app, { db, box, publicUrl }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }
  const envParams = z.object({ id: z.uuid(), envId: z.uuid() })

  async function findEnvironment(projectId: string, envId: string) {
    const [row] = await db
      .select({ env: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, envId), eq(environments.projectId, projectId)))
      .limit(1)
    return row ?? null
  }

  const url = (path: string) => new URL(`/api/hooks/${path}`, publicUrl).href

  async function configView(
    request: FastifyRequest,
    env: typeof environments.$inferSelect,
  ): Promise<WebhookConfigView> {
    // Les jetons permettent de déclencher un déploiement : réservés aux rôles qui le peuvent.
    const reveal = Boolean(request.user && hasRole(request.user.roles, 'vercio-deployer'))
    const [sources, events, globalList, repositories] = await Promise.all([
      db.select().from(environmentSources).where(eq(environmentSources.environmentId, env.id)),
      db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.environmentId, env.id))
        .orderBy(desc(webhookEvents.createdAt))
        .limit(50),
      webhookSettings(db),
      db
        .select({ id: appSources.id, repository: appSources.repository, provider: gitProviders })
        .from(appSources)
        .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
        .where(eq(appSources.projectId, env.projectId)),
    ])
    return {
      ipAllowlist: env.webhookIpAllowlist,
      globalIpAllowlist: globalList.ipAllowlist,
      enabled: globalList.enabled,
      sources: sources.map((source) => {
        const token = reveal && source.webhookTokenEnc ? box.decrypt(source.webhookTokenEnc) : null
        const repository = repositories.find((item) => item.id === source.appSourceId)
        const provider = repository?.provider.type ?? 'gitlab'
        return {
          appSourceId: source.appSourceId,
          provider,
          installedAt: source.webhookInstalledAt?.toISOString() ?? null,
          providerHooksUrl: repository
            ? `${repository.provider.webUrl}/${repository.repository}${provider === 'gitlab' ? '/-/hooks' : '/settings/hooks'}`
            : '',
          token,
          secret: reveal && source.webhookSecretEnc ? box.decrypt(source.webhookSecretEnc) : null,
          urls: token
            ? {
                generic: url(token),
                gitlab: url(`gitlab/${token}`),
                github: url(`github/${token}`),
              }
            : null,
        }
      }),
      events: events.map((row): WebhookEventView => ({
        id: row.id,
        appSourceId: row.appSourceId,
        kind: row.source,
        ip: row.ip,
        result: row.result as WebhookResult,
        reason: row.reason,
        details: row.payload as WebhookEventView['details'],
        deploymentId: row.deploymentId,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  }

  app.get('/projects/:id/environments/:envId/webhooks', viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    return configView(request, found.env)
  })

  /** Nouveau jeton et nouveau secret : les anciennes URL cessent immédiatement de fonctionner. */
  app.post(
    '/projects/:id/environments/:envId/webhooks/:sourceId/regenerate',
    deployer,
    async (request, reply) => {
      const params = parseInput(envParams.extend({ sourceId: z.uuid() }), request.params, reply)
      if (!params) return
      const found = await findEnvironment(params.id, params.envId)
      if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
      const updated = await db
        .update(environmentSources)
        // Le webhook distant porte l'ancienne URL : à recréer (mis à jour s'il existe encore).
        .set({ ...newWebhookCredentials(box), webhookInstalledAt: null })
        .where(
          and(
            eq(environmentSources.environmentId, params.envId),
            eq(environmentSources.appSourceId, params.sourceId),
          ),
        )
        .returning({ id: environmentSources.appSourceId })
      if (!updated.length) return reply.code(404).send({ error: 'Source introuvable' })
      const [installed] = await db
        .select({ id: environmentSources.webhookRemoteId })
        .from(environmentSources)
        .where(
          and(
            eq(environmentSources.environmentId, params.envId),
            eq(environmentSources.appSourceId, params.sourceId),
          ),
        )
      if (installed?.id) {
        // Webhook créé par Vercio : mis à jour avec la nouvelle URL, au mieux.
        await installRemoteWebhook(db, box, publicUrl, params.envId, params.sourceId).catch(
          (error: unknown) => request.log.warn({ err: error }, 'Webhook distant non mis à jour'),
        )
      }
      await auditAction(
        db,
        request,
        'webhook.regenerate',
        `${found.project.slug}/${found.env.slug}`,
        { appSourceId: params.sourceId },
      )
      return configView(request, found.env)
    },
  )

  /** Crée le webhook chez GitLab ou GitHub avec le token de la connexion (ou le met à jour). */
  app.post(
    '/projects/:id/environments/:envId/webhooks/:sourceId/install',
    admin,
    async (request, reply) => {
      const params = parseInput(envParams.extend({ sourceId: z.uuid() }), request.params, reply)
      if (!params) return
      const found = await findEnvironment(params.id, params.envId)
      if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
      if (!(await webhookSettings(db)).enabled) {
        return reply.code(409).send({
          error: 'Webhooks désactivés pour cette instance (Paramètres → Webhooks)',
        })
      }
      try {
        await installRemoteWebhook(db, box, publicUrl, params.envId, params.sourceId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await auditAction(
          db,
          request,
          'webhook.install',
          `${found.project.slug}/${found.env.slug}`,
          { appSourceId: params.sourceId, error: message },
          false,
        )
        return reply.code(error instanceof WebhookInstallError ? 400 : 502).send({
          error:
            error instanceof WebhookInstallError ? message : `Fournisseur injoignable : ${message}`,
        })
      }
      await auditAction(db, request, 'webhook.install', `${found.project.slug}/${found.env.slug}`, {
        appSourceId: params.sourceId,
      })
      return configView(request, found.env)
    },
  )

  app.put('/projects/:id/environments/:envId/webhooks', admin, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    const input = params && parseInput(ipAllowlistSchema, request.body, reply)
    if (!params || !input) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    const [env] = await db
      .update(environments)
      .set({ webhookIpAllowlist: input.ipAllowlist })
      .where(eq(environments.id, params.envId))
      .returning()
    await auditAction(db, request, 'webhook.allowlist', `${found.project.slug}/${found.env.slug}`, {
      ipAllowlist: input.ipAllowlist,
    })
    return configView(request, env!)
  })

  app.get('/settings/webhooks', admin, async (): Promise<WebhookSettings> => webhookSettings(db))

  app.put('/settings/webhooks', admin, async (request, reply) => {
    const input = parseInput(webhookSettingsInputSchema, request.body, reply)
    if (!input) return
    const current = await webhookSettings(db)
    const value: WebhookSettings = {
      enabled: input.enabled ?? current.enabled,
      ipAllowlist: input.ipAllowlist ?? current.ipAllowlist,
    }
    await db
      .insert(appSettings)
      .values({ key: WEBHOOK_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    await auditAction(db, request, 'settings.webhooks', 'webhooks', { ...value })
    return value
  })
}
