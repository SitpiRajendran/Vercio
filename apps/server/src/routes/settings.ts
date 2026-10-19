import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { count, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  gitProviderApiUrl,
  gitProviderInputSchema,
  REGISTRY_PROVIDER_TYPE,
  registryInputSchema,
  tokenHint,
  type ConnectionCheck,
  type GitProviderView,
  type RegistryView,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSources, gitProviders, registries, trackedServices } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import type { SecretBox } from '../lib/crypto.js'
import { gitProviderClient } from '../providers/git.js'
import { registryClientFor, type RegistryAccess } from '../providers/registry-access.js'

type GitProviderRow = typeof gitProviders.$inferSelect
type RegistryRow = typeof registries.$inferSelect

const idParams = z.object({ id: z.uuid() })
const gitProviderTestSchema = gitProviderInputSchema.extend({ id: z.uuid().optional() })
const registryTestSchema = registryInputSchema.extend({ id: z.uuid().optional() })

/** Paramètres d'administration : fournisseurs Git et registries (rôle vercio-admin). */
export const settingsRoutes: FastifyPluginAsync<{ db: Database; box: SecretBox }> = async (
  app,
  { db, box },
) => {
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

  function isUniqueViolation(error: unknown): boolean {
    const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code
    return code === '23505' || (error as { code?: string })?.code === '23505'
  }

  // --- Fournisseurs Git -------------------------------------------------------------------

  async function gitProviderView(row: GitProviderRow): Promise<GitProviderView> {
    const [usage] = await db
      .select({ value: count() })
      .from(appSources)
      .where(eq(appSources.gitProviderId, row.id))
    const linked = await db
      .select({ id: registries.id, name: registries.name, url: registries.url })
      .from(registries)
      .where(eq(registries.gitProviderId, row.id))
      .orderBy(registries.name)
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.webUrl,
      tokenHint: tokenHint(box.decrypt(row.tokenEnc)),
      caCertificate: row.caCertificate,
      lastCheck: (row.lastCheck as ConnectionCheck | null) ?? null,
      usedBy: usage?.value ?? 0,
      registries: linked,
    }
  }

  /** Registry d'images lié au fournisseur : même token, nom dérivé du fournisseur. */
  async function createLinkedRegistry(provider: GitProviderRow, url: string) {
    const base = `${provider.name} · images`
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const [row] = await db
          .insert(registries)
          .values({
            name: attempt === 1 ? base : `${base} ${attempt}`,
            type: provider.type === 'gitlab' ? 'gitlab' : 'ghcr',
            url: url.replace(/\/+$/, ''),
            gitProviderId: provider.id,
          })
          .returning()
        return row!
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new Error('Nom de registry indisponible')
  }

  async function findGitProvider(id: string) {
    const [row] = await db.select().from(gitProviders).where(eq(gitProviders.id, id)).limit(1)
    return row ?? null
  }

  app.get('/git-providers', async () => {
    const rows = await db.select().from(gitProviders).orderBy(gitProviders.name)
    return Promise.all(rows.map(gitProviderView))
  })

  app.post('/git-providers', async (request, reply) => {
    const input = parse(gitProviderInputSchema, request.body, reply)
    if (!input) return
    if (!input.token) return reply.code(400).send({ error: 'Token requis', field: 'token' })
    try {
      const [row] = await db
        .insert(gitProviders)
        .values({
          name: input.name,
          type: input.type,
          webUrl: input.url,
          apiUrl: gitProviderApiUrl(input.type, input.url),
          tokenEnc: box.encrypt(input.token),
          caCertificate: input.caCertificate ?? null,
        })
        .returning()
      if (input.imageRegistry) {
        const registry = await createLinkedRegistry(row!, input.imageRegistry.url)
        await track(request, 'settings.registry.create', registry.name)
      }
      await track(request, 'settings.git_provider.create', input.name)
      return reply.code(201).send(await gitProviderView(row!))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  /** Ajoute le registry d'images d'un fournisseur déjà enregistré. */
  app.post('/git-providers/:id/registry', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    const input =
      params && parse(z.object({ url: z.string().trim().min(1).max(255) }), request.body, reply)
    if (!params || !input) return
    const provider = await findGitProvider(params.id)
    if (!provider) return reply.code(404).send({ error: 'Fournisseur introuvable' })
    const registry = await createLinkedRegistry(provider, input.url)
    await track(request, 'settings.registry.create', registry.name)
    return reply.code(201).send(await gitProviderView(provider))
  })

  app.put('/git-providers/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    const input = params && parse(gitProviderInputSchema, request.body, reply)
    if (!params || !input) return
    const existing = await findGitProvider(params.id)
    if (!existing) return reply.code(404).send({ error: 'Fournisseur introuvable' })
    // Le token enregistré ne part jamais vers une autre adresse que celle où il a été saisi.
    if (!input.token && (existing.webUrl !== input.url || existing.type !== input.type)) {
      return reply.code(400).send({
        error: 'Ressaisissez le token pour changer d’adresse ou de type',
        field: 'token',
      })
    }
    try {
      const [row] = await db
        .update(gitProviders)
        .set({
          name: input.name,
          type: input.type,
          webUrl: input.url,
          apiUrl: gitProviderApiUrl(input.type, input.url),
          ...(input.token ? { tokenEnc: box.encrypt(input.token) } : {}),
          caCertificate: input.caCertificate ?? null,
          lastCheck: null,
        })
        .where(eq(gitProviders.id, params.id))
        .returning()
      await track(request, 'settings.git_provider.update', input.name)
      return gitProviderView(row!)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  app.delete('/git-providers/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const existing = await findGitProvider(params.id)
    if (!existing) return reply.code(404).send({ error: 'Fournisseur introuvable' })
    const view = await gitProviderView(existing)
    if (view.usedBy > 0) {
      return reply
        .code(409)
        .send({ error: `Utilisé par ${view.usedBy} source(s) de projet : supprimez-les d’abord` })
    }
    await db.delete(gitProviders).where(eq(gitProviders.id, params.id))
    await track(request, 'settings.git_provider.delete', existing.name)
    return reply.code(204).send()
  })

  /**
   * Test avant enregistrement (formulaire) : token vide = token déjà enregistré, mais seulement
   * vers la même adresse (sinon le token enregistré partirait vers un autre serveur).
   */
  app.post('/git-providers/test', async (request, reply) => {
    const input = parse(gitProviderTestSchema, request.body, reply)
    if (!input) return
    let token = input.token
    if (!token && input.id) {
      const existing = await findGitProvider(input.id)
      if (existing && (existing.type !== input.type || existing.webUrl !== input.url)) {
        return reply.code(400).send({
          error: 'Ressaisissez le token pour tester une autre adresse',
          field: 'token',
        })
      }
      token = existing ? box.decrypt(existing.tokenEnc) : undefined
    }
    if (!token) return reply.code(400).send({ error: 'Token requis', field: 'token' })
    return gitProviderClient({ ...input, token }).check()
  })

  app.post('/git-providers/:id/test', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const row = await findGitProvider(params.id)
    if (!row) return reply.code(404).send({ error: 'Fournisseur introuvable' })
    const result = await gitProviderClient({
      type: row.type,
      url: row.webUrl,
      token: box.decrypt(row.tokenEnc),
      caCertificate: row.caCertificate,
    }).check()
    await db.update(gitProviders).set({ lastCheck: result }).where(eq(gitProviders.id, row.id))
    return result
  })

  // --- Registries ---------------------------------------------------------------------

  async function registryView(row: RegistryRow): Promise<RegistryView> {
    const [usage] = await db
      .select({ value: count() })
      .from(trackedServices)
      .where(eq(trackedServices.registryId, row.id))
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      username: row.username,
      hasPassword: Boolean(row.passwordEnc),
      gitProviderId: row.gitProviderId,
      insecure: row.insecure,
      caCertificate: row.caCertificate,
      lastCheck: (row.lastCheck as ConnectionCheck | null) ?? null,
      usedBy: usage?.value ?? 0,
    }
  }

  async function findRegistry(id: string) {
    const [row] = await db.select().from(registries).where(eq(registries.id, id)).limit(1)
    return row ?? null
  }

  const registryClient = (input: RegistryAccess) => registryClientFor(db, box, input)

  /** Un registry ne peut réutiliser que le token d'un fournisseur du même écosystème. */
  async function checkLinkedProvider(input: {
    type: RegistryRow['type']
    gitProviderId?: string | null
  }): Promise<string | null> {
    if (!input.gitProviderId) return null
    const provider = await findGitProvider(input.gitProviderId)
    if (!provider) return 'Fournisseur Git introuvable'
    if (REGISTRY_PROVIDER_TYPE[input.type] !== provider.type) {
      return 'Ce fournisseur ne peut pas fournir les identifiants de ce type de registry'
    }
    return null
  }

  app.get('/registries', async () => {
    const rows = await db.select().from(registries).orderBy(registries.name)
    return Promise.all(rows.map(registryView))
  })

  app.post('/registries', async (request, reply) => {
    const input = parse(registryInputSchema, request.body, reply)
    if (!input) return
    const providerError = await checkLinkedProvider(input)
    if (providerError) return reply.code(400).send({ error: providerError, field: 'gitProviderId' })
    try {
      const [row] = await db
        .insert(registries)
        .values({
          name: input.name,
          type: input.type,
          url: input.url,
          username: input.username || null,
          passwordEnc: input.password ? box.encrypt(input.password) : null,
          gitProviderId: input.gitProviderId ?? null,
          insecure: input.insecure,
          caCertificate: input.caCertificate ?? null,
        })
        .returning()
      await track(request, 'settings.registry.create', input.name)
      return reply.code(201).send(await registryView(row!))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  app.put('/registries/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    const input = params && parse(registryInputSchema, request.body, reply)
    if (!params || !input) return
    const providerError = await checkLinkedProvider(input)
    if (providerError) return reply.code(400).send({ error: providerError, field: 'gitProviderId' })
    const existing = await findRegistry(params.id)
    if (!existing) return reply.code(404).send({ error: 'Registry introuvable' })
    if (
      !input.password &&
      existing.passwordEnc &&
      (existing.url !== input.url ||
        existing.type !== input.type ||
        (existing.username ?? '') !== (input.username ?? ''))
    ) {
      return reply.code(400).send({
        error: 'Ressaisissez le mot de passe pour changer d’adresse ou de compte',
        field: 'password',
      })
    }
    try {
      const [row] = await db
        .update(registries)
        .set({
          name: input.name,
          type: input.type,
          url: input.url,
          username: input.username || null,
          ...(input.password ? { passwordEnc: box.encrypt(input.password) } : {}),
          gitProviderId: input.gitProviderId ?? null,
          insecure: input.insecure,
          caCertificate: input.caCertificate ?? null,
          lastCheck: null,
        })
        .where(eq(registries.id, params.id))
        .returning()
      await track(request, 'settings.registry.update', input.name)
      return registryView(row!)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà utilisé', field: 'name' })
      }
      throw error
    }
  })

  app.delete('/registries/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const existing = await findRegistry(params.id)
    if (!existing) return reply.code(404).send({ error: 'Registry introuvable' })
    const view = await registryView(existing)
    if (view.usedBy > 0) {
      return reply
        .code(409)
        .send({ error: `Utilisé par ${view.usedBy} service(s) : supprimez-les d’abord` })
    }
    await db.delete(registries).where(eq(registries.id, params.id))
    await track(request, 'settings.registry.delete', existing.name)
    return reply.code(204).send()
  })

  app.post('/registries/test', async (request, reply) => {
    const input = parse(registryTestSchema, request.body, reply)
    if (!input) return
    const linkedError = await checkLinkedProvider(input)
    if (linkedError) return reply.code(400).send({ error: linkedError, field: 'gitProviderId' })
    let password = input.password
    if (!password && input.id) {
      const existing = await findRegistry(input.id)
      // Mot de passe enregistré : seulement vers le même registry et le même compte.
      if (
        existing?.passwordEnc &&
        (existing.type !== input.type ||
          existing.url !== input.url ||
          (existing.username ?? '') !== (input.username ?? ''))
      ) {
        return reply.code(400).send({
          error: 'Ressaisissez le mot de passe pour tester une autre adresse ou un autre compte',
          field: 'password',
        })
      }
      password = existing?.passwordEnc ? box.decrypt(existing.passwordEnc) : undefined
    }
    return (await registryClient({ ...input, password })).check()
  })

  app.post('/registries/:id/test', async (request, reply) => {
    const params = parse(idParams, request.params, reply)
    if (!params) return
    const row = await findRegistry(params.id)
    if (!row) return reply.code(404).send({ error: 'Registry introuvable' })
    const client = await registryClient({
      ...row,
      password: row.passwordEnc ? box.decrypt(row.passwordEnc) : null,
    })
    const result = await client.check()
    await db.update(registries).set({ lastCheck: result }).where(eq(registries.id, row.id))
    return result
  })
}
