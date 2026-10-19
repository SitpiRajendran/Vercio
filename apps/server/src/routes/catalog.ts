import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { composeCandidates, defaultComposeFile, hasRole } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSources, gitProviders, registries } from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { describeNetworkError } from '../lib/http.js'
import { analyzeCompose } from '../compose/analyze.js'
import { gitProviderClient, providerErrorStatus, type GitProviderClient } from '../providers/git.js'
import { parseInput } from './helpers.js'

/**
 * Données de référence pour les formulaires de projet : connexions disponibles (sans secrets),
 * dépôts, branches, fichiers et images lus chez les fournisseurs.
 */
export const catalogRoutes: FastifyPluginAsync<{ db: Database; box: SecretBox }> = async (
  app,
  { db, box },
) => {
  app.addHook('preHandler', app.requireRole('vercio-deployer'))

  app.get('/git-providers', async () =>
    db
      .select({
        id: gitProviders.id,
        name: gitProviders.name,
        type: gitProviders.type,
        url: gitProviders.webUrl,
      })
      .from(gitProviders)
      .orderBy(gitProviders.name),
  )

  app.get('/registries', async () =>
    db
      .select({
        id: registries.id,
        name: registries.name,
        type: registries.type,
        url: registries.url,
      })
      .from(registries)
      .orderBy(registries.name),
  )

  async function clientFor(id: string): Promise<GitProviderClient | null> {
    const [row] = await db.select().from(gitProviders).where(eq(gitProviders.id, id)).limit(1)
    if (!row) return null
    return gitProviderClient({
      type: row.type,
      url: row.webUrl,
      token: box.decrypt(row.tokenEnc),
      caCertificate: row.caCertificate,
    })
  }

  /** Appel au fournisseur : ses erreurs deviennent des 502 avec un message lisible. */
  async function callProvider<T>(
    id: string,
    reply: FastifyReply,
    action: (client: GitProviderClient) => Promise<T>,
  ) {
    const client = await clientFor(id)
    if (!client) return reply.code(404).send({ error: 'Fournisseur Git introuvable' })
    try {
      return await action(client)
    } catch (error) {
      const status = providerErrorStatus(error)
      const message = status ? (error as Error).message : describeNetworkError(error)
      return reply.code(status === 404 ? 404 : 502).send({ error: message })
    }
  }

  const providerParams = z.object({ id: z.uuid() })
  // Parcourir les dépôts et lire leurs fichiers sert à créer ou configurer un projet (admin) :
  // le token Git voit souvent bien plus que les projets de Vercio.
  const admin = { preHandler: app.requireRole('vercio-admin') }

  /** Déployeur : seulement les dépôts déjà utilisés par un projet. */
  async function repositoryAllowed(
    request: FastifyRequest,
    providerId: string,
    repository: string,
  ) {
    if (request.user && hasRole(request.user.roles, 'vercio-admin')) return true
    const [source] = await db
      .select({ id: appSources.id })
      .from(appSources)
      .where(and(eq(appSources.gitProviderId, providerId), eq(appSources.repository, repository)))
      .limit(1)
    return !!source
  }
  const forbidden = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'Dépôt non utilisé par un projet : réservé aux administrateurs' })

  app.get('/git-providers/:id/repositories', admin, async (request, reply) => {
    const params = parseInput(providerParams, request.params, reply)
    const query = parseInput(z.object({ q: z.string().max(100).default('') }), request.query, reply)
    if (!params || !query) return
    return callProvider(params.id, reply, (client) => client.searchRepositories(query.q))
  })

  const repositoryQuery = z.object({ repository: z.string().min(1).max(255) })

  app.get('/git-providers/:id/branches', async (request, reply) => {
    const params = parseInput(providerParams, request.params, reply)
    const query = parseInput(repositoryQuery, request.query, reply)
    if (!params || !query) return
    if (!(await repositoryAllowed(request, params.id, query.repository))) return forbidden(reply)
    return callProvider(params.id, reply, (client) => client.listBranches(query.repository))
  })

  app.get('/git-providers/:id/images', async (request, reply) => {
    const params = parseInput(providerParams, request.params, reply)
    const query = parseInput(repositoryQuery, request.query, reply)
    if (!params || !query) return
    if (!(await repositoryAllowed(request, params.id, query.repository))) return forbidden(reply)
    return callProvider(params.id, reply, (client) => client.registryImages(query.repository))
  })

  /** Fichiers YAML du dépôt pouvant être un fichier Compose, et le fichier standard détecté. */
  app.get('/git-providers/:id/compose-files', admin, async (request, reply) => {
    const params = parseInput(providerParams, request.params, reply)
    const query = parseInput(
      repositoryQuery.extend({ ref: z.string().min(1).max(255) }),
      request.query,
      reply,
    )
    if (!params || !query) return
    return callProvider(params.id, reply, async (client) => {
      const files = composeCandidates(await client.listFiles(query.repository, query.ref))
      return { files, detected: defaultComposeFile(files) }
    })
  })

  /** Lit un fichier Compose dans un dépôt et l'analyse. */
  app.post('/git-providers/:id/compose', admin, async (request, reply) => {
    const params = parseInput(providerParams, request.params, reply)
    const body = parseInput(
      repositoryQuery.extend({
        ref: z.string().min(1).max(255),
        path: z.string().min(1).max(255),
      }),
      request.body,
      reply,
    )
    if (!params || !body) return
    return callProvider(params.id, reply, async (client) => {
      const content = await client.getFile(body.repository, body.path, body.ref)
      return { content, analysis: analyzeCompose(content) }
    })
  })

  app.post('/compose/analyze', async (request, reply) => {
    const body = parseInput(z.object({ content: z.string().max(200_000) }), request.body, reply)
    if (!body) return
    return analyzeCompose(body.content)
  })
}
