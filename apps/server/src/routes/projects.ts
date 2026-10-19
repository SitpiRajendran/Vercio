import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  composeProjectName,
  PROJECT_COLORS,
  PROJECT_ICONS,
  projectAppearanceSchema,
  zeroDowntimeInputSchema,
  type ProjectAppearance,
  createProjectSchema,
  environmentInputSchema,
  environmentSourceInputSchema,
  restartPolicySchema,
  type RestartPolicy,
  projectInputSchema,
  variablesInputSchema,
  type EnvironmentView,
  type ProjectSummary,
  type ProjectView,
  type VariableView,
  hasRole,
} from '@vercio/shared'
import { analyzeCompose } from '../compose/analyze.js'
import { externalComposeProjects } from '../compose/imports.js'
import type { HostDriver } from '../docker/host-driver.js'
import type { Database } from '../db/client.js'
import {
  appSources,
  deployments,
  envVariables,
  environmentSources,
  environments,
  gitProviders,
  hosts,
  projects,
  registries,
  trackedServices,
  users,
} from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { describeNetworkError } from '../lib/http.js'
import { gitProviderClient, providerErrorStatus } from '../providers/git.js'
import { toSummary, type DeploymentEngine } from '../deploy/engine.js'
import { removeRemoteWebhooks } from '../webhooks/remote.js'
import type { VersionService } from '../versions/service.js'
import { newWebhookCredentials } from '../webhooks/service.js'
import { auditAction, HttpError, isUniqueViolation, parseInput, sendHttpError } from './helpers.js'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type ProjectInput = z.output<typeof projectInputSchema>

const idParams = z.object({ id: z.uuid() })
const envParams = z.object({ id: z.uuid(), envId: z.uuid() })
const variablesQuery = z.object({ environment: z.uuid().optional() })
const environmentUpdateSchema = z.object({
  name: environmentInputSchema.shape.name,
  sources: z.array(environmentSourceInputSchema),
  /** Absente : politique inchangée. */
  restartPolicy: restartPolicySchema.optional(),
})

export const projectRoutes: FastifyPluginAsync<{
  db: Database
  box: SecretBox
  versions: VersionService
  engine: DeploymentEngine
  host: HostDriver
}> = async (app, { db, box, versions, engine, host }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }

  // --- Lecture ---------------------------------------------------------------------------

  /** Projets Compose lancés hors de Vercio, proposés à la reprise (assistant de création). */
  app.get('/imports', admin, async (_request, reply) => {
    try {
      return await externalComposeProjects(db, host)
    } catch (error) {
      app.log.warn({ err: error }, 'Inventaire des projets Compose impossible')
      return reply.code(502).send({ error: 'Démon Docker injoignable : inventaire impossible' })
    }
  })

  app.get('/', viewer, async (): Promise<ProjectSummary[]> => {
    const rows = await db.select().from(projects).orderBy(projects.name)
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [sources, envs, envSources] = await Promise.all([
      db
        .select({
          projectId: appSources.projectId,
          name: appSources.name,
          repository: appSources.repository,
          gitProviderType: gitProviders.type,
        })
        .from(appSources)
        .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
        .where(inArray(appSources.projectId, ids)),
      db.select().from(environments).where(inArray(environments.projectId, ids)),
      db
        .select({ envSource: environmentSources, projectId: environments.projectId })
        .from(environmentSources)
        .innerJoin(environments, eq(environments.id, environmentSources.environmentId))
        .where(inArray(environments.projectId, ids)),
    ])
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      type: row.type,
      ...appearanceOf(row),
      sources: sources
        .filter((source) => source.projectId === row.id)
        .map(({ name, repository, gitProviderType }) => ({ name, repository, gitProviderType })),
      environments: envs
        .filter((env) => env.projectId === row.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((env) => {
          const refs = envSources.filter((es) => es.envSource.environmentId === env.id)
          return {
            name: env.name,
            slug: env.slug,
            refs: refs.map((es) => es.envSource.ref),
            locked: refs.some((es) => es.envSource.mode === 'locked'),
          }
        }),
      updatedAt: row.updatedAt.toISOString(),
    }))
  })

  async function projectView(projectId: string): Promise<ProjectView | null> {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    if (!project) return null
    const [sources, tracked, envs] = await Promise.all([
      db
        .select({ source: appSources, provider: gitProviders })
        .from(appSources)
        .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
        .where(eq(appSources.projectId, projectId))
        .orderBy(appSources.createdAt),
      db
        .select({ service: trackedServices, registry: registries })
        .from(trackedServices)
        .innerJoin(registries, eq(registries.id, trackedServices.registryId))
        .where(eq(trackedServices.projectId, projectId))
        .orderBy(trackedServices.serviceName),
      db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectId))
        .orderBy(environments.createdAt),
    ])
    const deploymentsByEnv = new Map<
      string,
      { last: EnvironmentView['lastDeployment']; current: EnvironmentView['current'] }
    >()
    for (const env of envs) {
      const recent = await db
        .select({ deployment: deployments, username: users.username })
        .from(deployments)
        .leftJoin(users, eq(users.id, deployments.userId))
        .where(eq(deployments.environmentId, env.id))
        .orderBy(desc(deployments.createdAt))
        .limit(20)
      const last = recent[0]
      const current = recent.find((row) => row.deployment.status === 'succeeded')
      deploymentsByEnv.set(env.id, {
        last: last ? toSummary(last.deployment, last.username) : null,
        current: current ? toSummary(current.deployment, current.username) : null,
      })
    }
    const envSources = envs.length
      ? await db
          .select()
          .from(environmentSources)
          .where(
            inArray(
              environmentSources.environmentId,
              envs.map((env) => env.id),
            ),
          )
      : []

    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      type: project.type,
      ...appearanceOf(project),
      zeroDowntimeServices: project.zeroDowntimeServices,
      updatedAt: project.updatedAt.toISOString(),
      compose:
        project.composeSource === 'git' && project.composeAppSourceId
          ? {
              source: 'git',
              appSourceId: project.composeAppSourceId,
              path: project.composePath ?? 'docker-compose.yml',
            }
          : { source: 'inline', content: project.composeInline ?? '' },
      sources: sources.map(({ source, provider }) => ({
        id: source.id,
        name: source.name,
        gitProviderId: provider.id,
        gitProviderName: provider.name,
        gitProviderType: provider.type,
        repository: source.repository,
        repositoryUrl: `${provider.webUrl}/${source.repository}`,
        defaultBranch: source.defaultBranch,
        tagConvention: {
          latestTagTemplate: source.latestTagTemplate,
          versionSource: source.versionSource,
          tagPattern: source.tagPattern,
          commitTagTemplate: source.commitTagTemplate,
        },
      })),
      trackedServices: tracked.map(({ service, registry }) => ({
        serviceName: service.serviceName,
        appSourceId: service.appSourceId,
        registryId: registry.id,
        registryName: registry.name,
        imageRepository: service.imageRepository,
        image: `${registry.url.replace(/^https?:\/\//, '')}/${service.imageRepository}`,
      })),
      environments: envs.map((env): EnvironmentView => ({
        id: env.id,
        name: env.name,
        slug: env.slug,
        composeProject: composeProjectName(project.slug, env.slug),
        restartPolicy: env.restartPolicy as RestartPolicy,
        migratingFrom: env.migratingFrom,
        sources: envSources
          .filter((es) => es.environmentId === env.id)
          .map((es) => ({
            appSourceId: es.appSourceId,
            branch: es.branch,
            ref: es.ref,
            mode: es.mode,
          })),
        lastDeployment: deploymentsByEnv.get(env.id)?.last ?? null,
        current: deploymentsByEnv.get(env.id)?.current ?? null,
      })),
    }
  }

  app.get('/:slug', viewer, async (request, reply) => {
    const params = parseInput(z.object({ slug: z.string() }), request.params, reply)
    if (!params) return
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, params.slug))
      .limit(1)
    const view = row && (await projectView(row.id))
    if (!view) return reply.code(404).send({ error: 'Projet introuvable' })
    return view
  })

  // --- Validation ------------------------------------------------------------------------

  /**
   * Vérifie les références (fournisseurs, registries, sources) et le fichier Compose.
   * Pour un Compose lu dans Git, le fichier est récupéré sur la branche par défaut de la source.
   */
  async function validateProject(input: ProjectInput) {
    const sourceKeys = new Set(input.sources.map((source) => source.key))
    if (sourceKeys.size !== input.sources.length) {
      throw new HttpError(400, 'Deux sources ont la même clé', 'sources')
    }

    const providerIds = [...new Set(input.sources.map((source) => source.gitProviderId))]
    const providers = providerIds.length
      ? await db.select().from(gitProviders).where(inArray(gitProviders.id, providerIds))
      : []
    if (providers.length !== providerIds.length) {
      throw new HttpError(400, 'Fournisseur Git introuvable', 'sources')
    }

    let content: string
    if (input.compose.source === 'inline') {
      content = input.compose.content
    } else {
      const { path } = input.compose
      const source = input.sources.find(
        (item) => item.key === (input.compose as { sourceKey: string }).sourceKey,
      )
      if (!source) throw new HttpError(400, 'Source du fichier Compose inconnue', 'compose')
      const provider = providers.find((item) => item.id === source.gitProviderId)!
      try {
        content = await gitProviderClient({
          type: provider.type,
          url: provider.webUrl,
          token: box.decrypt(provider.tokenEnc),
          caCertificate: provider.caCertificate,
        }).getFile(source.repository, path, source.defaultBranch)
      } catch (error) {
        const message = providerErrorStatus(error)
          ? (error as Error).message
          : describeNetworkError(error)
        throw new HttpError(400, `Lecture du fichier Compose impossible : ${message}`, 'compose')
      }
    }

    const analysis = analyzeCompose(content)
    if (analysis.error) throw new HttpError(400, analysis.error, 'compose')
    const serviceNames = new Set(analysis.services.map((service) => service.name))

    const registryIds = [...new Set(input.trackedServices.map((service) => service.registryId))]
    const found = registryIds.length
      ? await db
          .select({ id: registries.id })
          .from(registries)
          .where(inArray(registries.id, registryIds))
      : []
    if (found.length !== registryIds.length) {
      throw new HttpError(400, 'Registry introuvable', 'trackedServices')
    }
    const tracked = new Set<string>()
    for (const service of input.trackedServices) {
      if (!serviceNames.has(service.serviceName)) {
        throw new HttpError(
          400,
          `Service « ${service.serviceName} » absent du fichier Compose`,
          'trackedServices',
        )
      }
      if (tracked.has(service.serviceName)) {
        throw new HttpError(
          400,
          `Service « ${service.serviceName} » suivi deux fois`,
          'trackedServices',
        )
      }
      if (!sourceKeys.has(service.sourceKey)) {
        throw new HttpError(400, 'Source inconnue pour un service suivi', 'trackedServices')
      }
      tracked.add(service.serviceName)
    }
    return analysis
  }

  function checkEnvironmentSources(sources: { source: string }[], expected: string[]) {
    const given = sources.map((source) => source.source).sort()
    const wanted = [...expected].sort()
    if (given.length !== wanted.length || given.some((value, index) => value !== wanted[index])) {
      throw new HttpError(
        400,
        'Chaque source du projet doit avoir une branche dans l’environnement',
        'sources',
      )
    }
  }

  async function localHostId(tx: Tx): Promise<string> {
    const [host] = await tx
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.name, 'local'))
      .limit(1)
    if (!host) throw new Error('Hôte local absent')
    return host.id
  }

  async function writeSourcesAndServices(
    tx: Tx,
    projectId: string,
    input: ProjectInput,
    existingIds: Set<string>,
  ): Promise<Map<string, string>> {
    // Clé du formulaire -> identifiant en base (les sources existantes ont leur id pour clé).
    const ids = new Map<string, string>()
    for (const source of input.sources) {
      const values = {
        name: source.name,
        gitProviderId: source.gitProviderId,
        repository: source.repository,
        defaultBranch: source.defaultBranch,
        latestTagTemplate: source.latestTagTemplate,
        versionSource: source.versionSource,
        tagPattern: source.tagPattern,
        commitTagTemplate: source.commitTagTemplate,
      }
      if (existingIds.has(source.key)) {
        await tx.update(appSources).set(values).where(eq(appSources.id, source.key))
        ids.set(source.key, source.key)
      } else {
        const [row] = await tx
          .insert(appSources)
          .values({ projectId, ...values })
          .returning()
        ids.set(source.key, row!.id)
      }
    }
    await tx.delete(trackedServices).where(eq(trackedServices.projectId, projectId))
    if (input.trackedServices.length) {
      await tx.insert(trackedServices).values(
        input.trackedServices.map((service) => ({
          projectId,
          appSourceId: ids.get(service.sourceKey)!,
          registryId: service.registryId,
          serviceName: service.serviceName,
          imageRepository: service.imageRepository,
        })),
      )
    }
    return ids
  }

  function composeColumns(input: ProjectInput, sourceIds: Map<string, string>) {
    return input.compose.source === 'inline'
      ? {
          composeSource: 'inline' as const,
          composeInline: input.compose.content,
          composeAppSourceId: null,
          composePath: null,
        }
      : {
          composeSource: 'git' as const,
          composeInline: null,
          composeAppSourceId: sourceIds.get(input.compose.sourceKey)!,
          composePath: input.compose.path,
        }
  }

  // --- Création, modification, suppression --------------------------------------------

  app.post('/', admin, async (request, reply) => {
    const input = parseInput(createProjectSchema, request.body, reply)
    if (!input) return
    try {
      await validateProject(input)
      const envSlugs = new Set(input.environments.map((env) => env.slug))
      if (envSlugs.size !== input.environments.length) {
        throw new HttpError(400, 'Deux environnements ont le même identifiant', 'environments')
      }
      const migrated = input.environments.flatMap((env) =>
        env.migration ? [env.migration.composeProject] : [],
      )
      if (new Set(migrated).size !== migrated.length) {
        throw new HttpError(
          400,
          'Un projet existant ne peut être repris qu’une fois',
          'environments',
        )
      }
      for (const env of input.environments) {
        checkEnvironmentSources(
          env.sources,
          input.sources.map((source) => source.key),
        )
      }

      const projectId = await db.transaction(async (tx) => {
        const [project] = await tx
          .insert(projects)
          .values({
            name: input.name,
            slug: input.slug,
            description: input.description || null,
            type: input.type,
            ...appearanceColumns(input),
          })
          .returning()
        const sourceIds = await writeSourcesAndServices(tx, project!.id, input, new Set())
        await tx
          .update(projects)
          .set(composeColumns(input, sourceIds))
          .where(eq(projects.id, project!.id))

        const hostId = await localHostId(tx)
        // `now()` est figé pour la transaction : dates espacées d'1 ms pour garder l'ordre saisi.
        const createdAt = Date.now()
        for (const [index, env] of input.environments.entries()) {
          const [row] = await tx
            .insert(environments)
            .values({
              projectId: project!.id,
              hostId,
              name: env.name,
              slug: env.slug,
              restartPolicy: env.restartPolicy,
              migratingFrom: env.migration?.composeProject ?? null,
              volumeMap: env.migration?.volumes ?? {},
              createdAt: new Date(createdAt + index),
            })
            .returning()
          if (env.sources.length) {
            await tx.insert(environmentSources).values(
              env.sources.map((source) => ({
                environmentId: row!.id,
                appSourceId: sourceIds.get(source.source)!,
                branch: source.branch,
                ref: source.ref,
                mode: source.mode,
                ...newWebhookCredentials(box),
              })),
            )
          }
        }
        return project!.id
      })
      await auditAction(db, request, 'project.create', input.slug)
      return reply.code(201).send(await projectView(projectId))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send({ error: 'Cet identifiant de projet est déjà utilisé', field: 'slug' })
      }
      return sendHttpError(reply, error)
    }
  })

  app.put('/:id', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(projectInputSchema, request.body, reply)
    if (!params || !input) return
    const [project] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)
    if (!project) return reply.code(404).send({ error: 'Projet introuvable' })
    if (input.slug !== project.slug) {
      // Le slug compose les noms Docker des environnements : il ne change pas après création.
      return reply
        .code(400)
        .send({ error: 'L’identifiant du projet ne peut pas être modifié', field: 'slug' })
    }
    try {
      await validateProject(input)
      await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: appSources.id })
          .from(appSources)
          .where(eq(appSources.projectId, project.id))
        const existingIds = new Set(existing.map((row) => row.id))
        const kept = new Set(input.sources.map((source) => source.key))
        const removed = [...existingIds].filter((id) => !kept.has(id))
        if (removed.length) {
          await tx
            .update(projects)
            .set({ composeAppSourceId: null })
            .where(eq(projects.id, project.id))
          await tx.delete(appSources).where(inArray(appSources.id, removed))
        }
        const sourceIds = await writeSourcesAndServices(tx, project.id, input, existingIds)
        await tx
          .update(projects)
          .set({
            name: input.name,
            description: input.description || null,
            type: input.type,
            ...appearanceColumns(input),
            ...composeColumns(input, sourceIds),
          })
          .where(eq(projects.id, project.id))

        // Une nouvelle source est ajoutée à chaque environnement, sur sa branche par défaut.
        const added = input.sources.filter((source) => !existingIds.has(source.key))
        if (added.length) {
          const envs = await tx
            .select({ id: environments.id })
            .from(environments)
            .where(eq(environments.projectId, project.id))
          const rows = envs.flatMap((env) =>
            added.map((source) => ({
              environmentId: env.id,
              appSourceId: sourceIds.get(source.key)!,
              branch: source.defaultBranch,
              ...newWebhookCredentials(box),
            })),
          )
          if (rows.length) await tx.insert(environmentSources).values(rows)
        }
      })
      // Convention de tags ou images suivies modifiées : les versions affichées sont relues.
      for (const source of input.sources) versions.invalidate(source.key)
      await auditAction(db, request, 'project.update', project.slug)
      return projectView(project.id)
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  /** Icône, couleur ou image seules : sans renvoyer toute la configuration du projet. */
  app.put('/:id/appearance', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(projectAppearanceSchema, request.body, reply)
    if (!params || !input) return
    const [updated] = await db
      .update(projects)
      .set(appearanceColumns(input))
      .where(eq(projects.id, params.id))
      .returning({ slug: projects.slug })
    if (!updated) return reply.code(404).send({ error: 'Projet introuvable' })
    await auditAction(db, request, 'project.appearance', updated.slug)
    return projectView(params.id)
  })

  /** Services mis à jour sans coupure : pris en compte au prochain déploiement. */
  app.put('/:id/zero-downtime', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(zeroDowntimeInputSchema, request.body, reply)
    if (!params || !input) return
    const [updated] = await db
      .update(projects)
      .set({ zeroDowntimeServices: input.services })
      .where(eq(projects.id, params.id))
      .returning({ slug: projects.slug })
    if (!updated) return reply.code(404).send({ error: 'Projet introuvable' })
    await auditAction(db, request, 'project.zero_downtime', updated.slug, {
      services: input.services,
    })
    return projectView(params.id)
  })

  app.delete('/:id', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const [project] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)
    if (!project) return reply.code(404).send({ error: 'Projet introuvable' })
    const envs = await db
      .select({ id: environments.id, slug: environments.slug })
      .from(environments)
      .where(eq(environments.projectId, project.id))
    for (const env of envs) await engine.destroy(project.slug, env.slug)
    await removeRemoteWebhooks(
      db,
      box,
      envs.map((env) => env.id),
      request.log,
    )
    await db.delete(projects).where(eq(projects.id, project.id))
    await auditAction(db, request, 'project.delete', project.slug)
    return reply.code(204).send()
  })

  // --- Environnements --------------------------------------------------------------------

  async function projectSourceIds(projectId: string) {
    const rows = await db
      .select({ id: appSources.id })
      .from(appSources)
      .where(eq(appSources.projectId, projectId))
    return rows.map((row) => row.id)
  }

  app.post('/:id/environments', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(environmentInputSchema, request.body, reply)
    if (!params || !input) return
    const [project] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)
    if (!project) return reply.code(404).send({ error: 'Projet introuvable' })
    try {
      checkEnvironmentSources(input.sources, await projectSourceIds(project.id))
      await db.transaction(async (tx) => {
        const [env] = await tx
          .insert(environments)
          .values({
            projectId: project.id,
            hostId: await localHostId(tx),
            name: input.name,
            slug: input.slug,
            restartPolicy: input.restartPolicy,
            migratingFrom: input.migration?.composeProject ?? null,
            volumeMap: input.migration?.volumes ?? {},
          })
          .returning()
        if (input.sources.length) {
          await tx.insert(environmentSources).values(
            input.sources.map((source) => ({
              environmentId: env!.id,
              appSourceId: source.source,
              branch: source.branch,
              ref: source.ref,
              mode: source.mode,
              ...newWebhookCredentials(box),
            })),
          )
        }
      })
      await auditAction(db, request, 'environment.create', `${project.slug}/${input.slug}`)
      return reply.code(201).send(await projectView(project.id))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Cet environnement existe déjà', field: 'slug' })
      }
      return sendHttpError(reply, error)
    }
  })

  async function findEnvironment(projectId: string, envId: string) {
    const [row] = await db
      .select({ env: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, envId), eq(environments.projectId, projectId)))
      .limit(1)
    return row ?? null
  }

  /** Branche, version et verrouillage : modifiables par un deployer. */
  app.put('/:id/environments/:envId', deployer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    const input = params && parseInput(environmentUpdateSchema, request.body, reply)
    if (!params || !input) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    // Le fichier Compose est lu sur la branche de l'environnement : la changer revient à choisir
    // ce qui tourne sur l'hôte (volumes, privilèges). Réservé aux administrateurs.
    if (
      found.project.composeSource === 'git' &&
      found.project.composeAppSourceId &&
      !(request.user && hasRole(request.user.roles, 'vercio-admin'))
    ) {
      const [current] = await db
        .select({ branch: environmentSources.branch })
        .from(environmentSources)
        .where(
          and(
            eq(environmentSources.environmentId, params.envId),
            eq(environmentSources.appSourceId, found.project.composeAppSourceId),
          ),
        )
      const next = input.sources.find((item) => item.source === found.project.composeAppSourceId)
      if (current && next && next.branch !== current.branch) {
        return reply.code(403).send({
          error:
            'Le fichier Compose est lu sur cette branche : seul un administrateur peut la changer',
          field: 'branch',
        })
      }
    }
    try {
      checkEnvironmentSources(input.sources, await projectSourceIds(params.id))
      await db.transaction(async (tx) => {
        await tx
          .update(environments)
          .set({
            name: input.name,
            ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
          })
          .where(eq(environments.id, params.envId))
        for (const source of input.sources) {
          await tx
            .update(environmentSources)
            .set({ branch: source.branch, ref: source.ref, mode: source.mode })
            .where(
              and(
                eq(environmentSources.environmentId, params.envId),
                eq(environmentSources.appSourceId, source.source),
              ),
            )
        }
      })
      await auditAction(
        db,
        request,
        'environment.update',
        `${found.project.slug}/${found.env.slug}`,
        {
          sources: input.sources,
          ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
        },
      )
      return projectView(params.id)
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.delete('/:id/environments/:envId', admin, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    await engine.destroy(found.project.slug, found.env.slug)
    await removeRemoteWebhooks(db, box, [params.envId], request.log)
    await db.delete(environments).where(eq(environments.id, params.envId))
    await auditAction(db, request, 'environment.delete', `${found.project.slug}/${found.env.slug}`)
    return reply.code(204).send()
  })

  // --- Versions disponibles -----------------------------------------------------------------

  app.get('/:id/versions', viewer, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const query =
      params &&
      parseInput(
        z.object({
          source: z.uuid(),
          branch: z.string().min(1).max(255),
          refresh: z.enum(['0', '1']).optional(),
        }),
        request.query,
        reply,
      )
    if (!params || !query) return
    const [source] = await db
      .select({ id: appSources.id })
      .from(appSources)
      .where(and(eq(appSources.id, query.source), eq(appSources.projectId, params.id)))
      .limit(1)
    if (!source) return reply.code(404).send({ error: 'Source introuvable' })
    try {
      return await versions.choices(source.id, query.branch, query.refresh === '1')
    } catch (error) {
      const message = providerErrorStatus(error)
        ? (error as Error).message
        : describeNetworkError(error)
      return reply.code(502).send({ error: `Lecture des versions impossible : ${message}` })
    }
  })

  // --- Variables -------------------------------------------------------------------------

  async function scopeCheck(projectId: string, environmentId: string | undefined) {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    if (!project) return null
    if (environmentId && !(await findEnvironment(projectId, environmentId))) return null
    return project
  }

  function scopeCondition(projectId: string, environmentId: string | undefined) {
    return and(
      eq(envVariables.projectId, projectId),
      environmentId
        ? eq(envVariables.environmentId, environmentId)
        : isNull(envVariables.environmentId),
    )
  }

  app.get('/:id/variables', viewer, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const query = params && parseInput(variablesQuery, request.query, reply)
    if (!params || !query) return
    if (!(await scopeCheck(params.id, query.environment))) {
      return reply.code(404).send({ error: 'Projet ou environnement introuvable' })
    }
    const rows = await db
      .select()
      .from(envVariables)
      .where(scopeCondition(params.id, query.environment))
      .orderBy(envVariables.key)
    return rows.map((row): VariableView => ({
      key: row.key,
      value: row.secret ? null : box.decrypt(row.valueEnc),
      secret: row.secret,
    }))
  })

  app.put('/:id/variables', deployer, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const query = params && parseInput(variablesQuery, request.query, reply)
    const input = query && parseInput(variablesInputSchema, request.body, reply)
    if (!params || !query || !input) return
    const project = await scopeCheck(params.id, query.environment)
    if (!project) return reply.code(404).send({ error: 'Projet ou environnement introuvable' })

    const existing = await db
      .select()
      .from(envVariables)
      .where(scopeCondition(params.id, query.environment))
    const previous = new Map(existing.map((row) => [row.key, row]))
    const rows: (typeof envVariables.$inferInsert)[] = []
    for (const variable of input.variables) {
      let valueEnc: string
      if (variable.value === null) {
        // Secret laissé vide : on garde la valeur enregistrée.
        const kept = previous.get(variable.key)
        if (!kept)
          return reply
            .code(400)
            .send({ error: `Valeur requise pour ${variable.key}`, field: variable.key })
        valueEnc = kept.valueEnc
      } else {
        valueEnc = box.encrypt(variable.value)
      }
      rows.push({
        projectId: params.id,
        environmentId: query.environment ?? null,
        key: variable.key,
        valueEnc,
        // Valeur gardée : un secret le reste (sinon la valeur s'afficherait en clair).
        secret:
          variable.secret || (variable.value === null && !!previous.get(variable.key)?.secret),
      })
    }
    await db.transaction(async (tx) => {
      await tx.delete(envVariables).where(scopeCondition(params.id, query.environment))
      if (rows.length) await tx.insert(envVariables).values(rows)
    })
    await auditAction(db, request, 'variables.update', project.slug, {
      environmentId: query.environment ?? null,
      keys: input.variables.map((variable) => variable.key),
    })
    return reply.code(204).send()
  })
}

/** Colonnes d'apparence fournies (absentes : inchangées ; null : retirées). */
function appearanceColumns(input: {
  icon?: string | null
  color?: string | null
  logo?: string | null
  url?: string | null
}) {
  return {
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.logo !== undefined ? { logo: input.logo } : {}),
    ...(input.url !== undefined ? { url: input.url || null } : {}),
  }
}

/** Apparence lue en base ; une valeur inconnue (liste réduite depuis) est ignorée. */
export function appearanceOf(row: {
  icon: string | null
  color: string | null
  logo: string | null
  url: string | null
}): ProjectAppearance {
  return {
    icon: PROJECT_ICONS.find((icon) => icon === row.icon) ?? null,
    color: PROJECT_COLORS.find((color) => color === row.color) ?? null,
    logo: row.logo,
    url: row.url,
  }
}
