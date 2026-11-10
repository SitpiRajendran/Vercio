import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { ssoSettingsInputSchema, type SsoSettingsView } from '@vercio/shared'
import { SsoSettingsError, type SsoManager } from '../auth/sso.js'
import type { Database } from '../db/client.js'
import { sessions, users } from '../db/schema.js'
import { audit } from '../lib/audit.js'

const draftSchema = ssoSettingsInputSchema.pick({
  issuer: true,
  clientId: true,
  clientSecret: true,
  scopes: true,
})

/** Paramètres → Connexion SSO (rôle vercio-admin). Appliqué à chaud, sans redémarrage. */
export const ssoRoutes: FastifyPluginAsync<{ db: Database; sso: SsoManager }> = async (
  app,
  { db, sso },
) => {
  app.addHook('preHandler', app.requireRole('vercio-admin'))

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof SsoSettingsError) {
      return reply.code(error.status).send({ error: error.message, field: error.field })
    }
    throw error
  }

  function badRequest(reply: FastifyReply, issue?: { message: string; path: PropertyKey[] }) {
    return reply
      .code(400)
      .send({ error: issue?.message ?? 'Requête invalide', field: issue?.path.join('.') })
  }

  /** Couper le SSO depuis une session SSO enfermerait dehors : il faut un compte local. */
  function refuseFromSsoSession(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.user?.provider !== 'oidc') return false
    reply.code(409).send({
      error:
        'Vous êtes connecté par le SSO : connectez-vous avec un compte local pour le désactiver',
    })
    return true
  }

  /** SSO coupé ou changé de fournisseur : les sessions SSO ouvertes sont fermées. */
  async function closeSsoSessions() {
    const ssoUsers = db.select({ id: users.id }).from(users).where(eq(users.provider, 'oidc'))
    await db.delete(sessions).where(inArray(sessions.userId, ssoUsers))
  }

  function track(request: FastifyRequest, action: string, target: string) {
    return audit(db, {
      userId: request.user?.id,
      username: request.user?.username,
      action,
      target,
      ip: request.ip,
      success: true,
    })
  }

  app.get('/', async (): Promise<SsoSettingsView> => sso.view())

  app.put('/', async (request, reply) => {
    const parsed = ssoSettingsInputSchema.safeParse(request.body)
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0])
    const before = await sso.view()
    const input = parsed.data
    const disabling = before.enabled && !input.enabled
    const otherProvider = before.source === 'settings' && before.issuer !== input.issuer
    if ((disabling || otherProvider) && refuseFromSsoSession(request, reply)) return
    try {
      await sso.save({ ...input, clientSecret: input.clientSecret || undefined })
    } catch (error) {
      return fail(reply, error)
    }
    if (disabling || otherProvider) await closeSsoSessions()
    await track(
      request,
      input.enabled ? 'settings.sso.update' : 'settings.sso.disable',
      input.issuer,
    )
    return sso.view()
  })

  app.post('/test', async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body)
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0])
    try {
      return await sso.test({ ...parsed.data, clientSecret: parsed.data.clientSecret || undefined })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete('/', async (request, reply) => {
    if (refuseFromSsoSession(request, reply)) return
    const before = await sso.view()
    try {
      await sso.remove()
    } catch (error) {
      return fail(reply, error)
    }
    await closeSsoSessions()
    await track(request, 'settings.sso.remove', before.issuer)
    return reply.code(204).send()
  })
}
