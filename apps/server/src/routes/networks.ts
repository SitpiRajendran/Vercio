import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import {
  composeProjectName,
  environmentLinkSchema,
  environmentNetworksSchema,
  LINK_KINDS,
  linkDatabaseName,
  linkUrl,
  sharedNetworkDockerName,
  sharedNetworkNameSchema,
  sharedNetworkInputSchema,
  sharedNetworkUpdateSchema,
  type EnvironmentLinkResult,
  type EnvironmentRef,
  type LinkTarget,
  type SharedNetworkView,
} from '@vercio/shared'
import { analyzeCompose } from '../compose/analyze.js'
import type { Database } from '../db/client.js'
import {
  deployments,
  envVariables,
  environmentNetworks,
  environments,
  projects,
  sharedNetworks,
} from '../db/schema.js'
import type { CommandRunner } from '../deploy/command.js'
import type { HostDriver, NetworkState } from '../docker/host-driver.js'
import type { SecretBox } from '../lib/crypto.js'
import { declaredPort, linkKind, provisionDatabase, randomPassword } from '../networks/links.js'
import { auditAction, parseInput } from './helpers.js'

type EnvironmentRow = typeof environments.$inferSelect
type ProjectRow = typeof projects.$inferSelect

function ref(project: ProjectRow, environment: EnvironmentRow): EnvironmentRef {
  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    environmentId: environment.id,
    environmentSlug: environment.slug,
    environmentName: environment.name,
  }
}

/** Réseaux partagés : un service d'un environnement, joignable par alias depuis d'autres. */
export const networkRoutes: FastifyPluginAsync<{
  db: Database
  host: HostDriver
  box: SecretBox
  runner: CommandRunner
  dockerSocket: string
  dataDir: string
}> = async (app, { db, host, box, runner, dockerSocket, dataDir }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }
  const idParams = z.object({ id: z.uuid() })

  async function environmentWithProject(environmentId: string) {
    const [row] = await db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(environments.id, environmentId))
      .limit(1)
    return row ?? null
  }

  /** Services du dernier fichier Compose déployé ; null si l'environnement n'a jamais été déployé. */
  async function deployedServices(environmentId: string): Promise<string[] | null> {
    const [last] = await db
      .select({ compose: deployments.composeRendered })
      .from(deployments)
      .where(and(eq(deployments.environmentId, environmentId), eq(deployments.status, 'succeeded')))
      .orderBy(desc(deployments.createdAt))
      .limit(1)
    if (!last?.compose) return null
    return analyzeCompose(last.compose).services.map((service) => service.name)
  }

  async function checkService(environmentId: string, service: string) {
    const services = await deployedServices(environmentId)
    return !services || services.includes(service)
  }

  async function aliasTaken(alias: string, exceptId?: string) {
    const [row] = await db
      .select({ id: sharedNetworks.id })
      .from(sharedNetworks)
      .where(
        and(
          eq(sharedNetworks.alias, alias),
          exceptId ? ne(sharedNetworks.id, exceptId) : undefined,
        ),
      )
      .limit(1)
    return !!row
  }

  async function views(): Promise<SharedNetworkView[]> {
    const rows = await db
      .select({ network: sharedNetworks, environment: environments, project: projects })
      .from(sharedNetworks)
      .innerJoin(environments, eq(environments.id, sharedNetworks.exposedByEnvironmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .orderBy(sharedNetworks.name)
    const subscriptions = rows.length
      ? await db
          .select({
            subscription: environmentNetworks,
            environment: environments,
            project: projects,
          })
          .from(environmentNetworks)
          .innerJoin(environments, eq(environments.id, environmentNetworks.environmentId))
          .innerJoin(projects, eq(projects.id, environments.projectId))
          .where(
            inArray(
              environmentNetworks.sharedNetworkId,
              rows.map((row) => row.network.id),
            ),
          )
          .orderBy(projects.slug, environments.slug)
      : []
    let states: Map<string, NetworkState> | null = null
    try {
      states = await host.networks(rows.map((row) => sharedNetworkDockerName(row.network.name)))
    } catch {
      // Docker injoignable : l'état n'est pas affiché.
    }
    return rows.map(({ network, environment, project }) => {
      const dockerName = sharedNetworkDockerName(network.name)
      const state = states?.get(dockerName)
      return {
        id: network.id,
        name: network.name,
        dockerName,
        alias: network.alias,
        description: network.description,
        exposedBy: { ...ref(project, environment), service: network.service },
        subscribers: subscriptions
          .filter((row) => row.subscription.sharedNetworkId === network.id)
          .map((row) => ({
            ...ref(row.project, row.environment),
            services: row.subscription.services ?? null,
          })),
        docker: states ? { exists: !!state, containers: state?.containers ?? [] } : null,
        createdAt: network.createdAt.toISOString(),
      }
    })
  }

  app.get('/networks', viewer, async () => views())

  app.post('/networks', admin, async (request, reply) => {
    const input = parseInput(sharedNetworkInputSchema, request.body, reply)
    if (!input) return
    const found = await environmentWithProject(input.environmentId)
    if (!found) {
      return reply.code(400).send({ error: 'Environnement introuvable', field: 'environmentId' })
    }
    const [existing] = await db
      .select({ id: sharedNetworks.id })
      .from(sharedNetworks)
      .where(eq(sharedNetworks.name, input.name))
      .limit(1)
    if (existing) {
      return reply.code(409).send({ error: 'Ce nom de réseau est déjà utilisé', field: 'name' })
    }
    if (await aliasTaken(input.alias)) {
      return reply
        .code(409)
        .send({ error: 'Cet alias est déjà utilisé par un autre réseau partagé', field: 'alias' })
    }
    if (!(await checkService(input.environmentId, input.service))) {
      return reply.code(400).send({
        error: `Le service « ${input.service} » n’existe pas dans le dernier déploiement de cet environnement`,
        field: 'service',
      })
    }
    const [row] = await db
      .insert(sharedNetworks)
      .values({
        name: input.name,
        exposedByEnvironmentId: input.environmentId,
        service: input.service,
        alias: input.alias,
        description: input.description,
      })
      .returning()
    await auditAction(db, request, 'network.create', input.name, {
      exposedBy: `${found.project.slug}/${found.environment.slug}`,
      service: input.service,
      alias: input.alias,
    })
    return reply.code(201).send((await views()).find((view) => view.id === row!.id))
  })

  app.put('/networks/:id', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(sharedNetworkUpdateSchema, request.body, reply)
    if (!params || !input) return
    const [network] = await db
      .select()
      .from(sharedNetworks)
      .where(eq(sharedNetworks.id, params.id))
      .limit(1)
    if (!network) return reply.code(404).send({ error: 'Réseau introuvable' })
    if (await aliasTaken(input.alias, network.id)) {
      return reply
        .code(409)
        .send({ error: 'Cet alias est déjà utilisé par un autre réseau partagé', field: 'alias' })
    }
    if (!(await checkService(network.exposedByEnvironmentId, input.service))) {
      return reply.code(400).send({
        error: `Le service « ${input.service} » n’existe pas dans le dernier déploiement de cet environnement`,
        field: 'service',
      })
    }
    await db
      .update(sharedNetworks)
      .set({ service: input.service, alias: input.alias, description: input.description })
      .where(eq(sharedNetworks.id, network.id))
    await auditAction(db, request, 'network.update', network.name, {
      service: input.service,
      alias: input.alias,
    })
    return (await views()).find((view) => view.id === network.id)
  })

  app.delete('/networks/:id', admin, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const [network] = await db
      .select()
      .from(sharedNetworks)
      .where(eq(sharedNetworks.id, params.id))
      .limit(1)
    if (!network) return reply.code(404).send({ error: 'Réseau introuvable' })
    await db.delete(sharedNetworks).where(eq(sharedNetworks.id, network.id))
    // Les conteneurs attachés gardent le réseau jusqu'à leur prochain déploiement.
    let docker: 'removed' | 'missing' | 'in_use' | 'error'
    try {
      docker = await host.removeNetwork(sharedNetworkDockerName(network.name))
    } catch {
      docker = 'error'
    }
    await auditAction(db, request, 'network.delete', network.name, { docker })
    return { docker }
  })

  /** Nom libre pour un nouveau réseau, dérivé de l'alias (`skillin-db`, `skillin-db-2`…). */
  async function freeNetworkName(alias: string) {
    const base = alias.slice(0, 36).replace(/-+$/, '')
    for (let index = 1; ; index++) {
      const name = index === 1 ? base : `${base}-${index}`
      const [taken] = await db
        .select({ id: sharedNetworks.id })
        .from(sharedNetworks)
        .where(eq(sharedNetworks.name, name))
        .limit(1)
      if (!taken && sharedNetworkNameSchema.safeParse(name).success) return name
    }
  }

  /** Services du dernier déploiement réussi, avec leur image et leurs ports. */
  async function deployedAnalysis(environmentId: string) {
    const [last] = await db
      .select({ compose: deployments.composeRendered })
      .from(deployments)
      .where(and(eq(deployments.environmentId, environmentId), eq(deployments.status, 'succeeded')))
      .orderBy(desc(deployments.createdAt))
      .limit(1)
    return last?.compose ? analyzeCompose(last.compose).services : null
  }

  /** Liaisons de cet environnement : nom utilisé et service joint. */
  async function linksOf(environmentId: string) {
    return db
      .select({ network: sharedNetworks })
      .from(environmentNetworks)
      .innerJoin(sharedNetworks, eq(sharedNetworks.id, environmentNetworks.sharedNetworkId))
      .where(eq(environmentNetworks.environmentId, environmentId))
  }

  /** Services joignables depuis cet environnement : ceux des autres projets déjà déployés. */
  app.get('/projects/:id/environments/:envId/link-targets', admin, async (request, reply) => {
    const params = parseInput(z.object({ id: z.uuid(), envId: z.uuid() }), request.params, reply)
    if (!params) return
    const found = await environmentWithProject(params.envId)
    if (!found || found.project.id !== params.id) {
      return reply.code(404).send({ error: 'Environnement introuvable' })
    }
    const others = await db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(ne(projects.id, found.project.id))
      .orderBy(projects.name, environments.name)
    const links = await linksOf(found.environment.id)
    const targets: LinkTarget[] = []
    for (const { environment, project } of others) {
      const services = await deployedAnalysis(environment.id)
      if (!services) continue
      let running: Set<string> | null = null
      try {
        running = new Set(
          (await host.listContainers(composeProjectName(project.slug, environment.slug)))
            .filter((container) => container.state === 'running' && !container.relayFor)
            .map((container) => container.service),
        )
      } catch {
        // Docker injoignable : état inconnu.
      }
      for (const service of services) {
        const kind = linkKind(service.image)
        const link = links.find(
          (item) =>
            item.network.exposedByEnvironmentId === environment.id &&
            item.network.service === service.name,
        )
        targets.push({
          ...ref(project, environment),
          service: service.name,
          image: service.image,
          kind,
          port: LINK_KINDS[kind].port ?? declaredPort(service.ports),
          running: running ? running.has(service.name) : false,
          linkedAs: link?.network.alias ?? null,
        })
      }
    }
    return targets
  })

  /**
   * « Connecter un service » : un réseau propre à cette liaison (deux applications reliées au
   * même service ne se voient pas), au besoin une base et un utilisateur dédiés, la variable de
   * connexion, et un redéploiement. Les conteneurs en marche sont branchés tout de suite.
   */
  app.post('/projects/:id/environments/:envId/links', admin, async (request, reply) => {
    const params = parseInput(z.object({ id: z.uuid(), envId: z.uuid() }), request.params, reply)
    const input = params && parseInput(environmentLinkSchema, request.body, reply)
    if (!params || !input) return
    const found = await environmentWithProject(params.envId)
    if (!found || found.project.id !== params.id) {
      return reply.code(404).send({ error: 'Environnement introuvable' })
    }
    const target = await environmentWithProject(input.targetEnvironmentId)
    if (!target) {
      return reply.code(400).send({ error: 'Projet introuvable', field: 'targetEnvironmentId' })
    }
    if (target.project.id === found.project.id) {
      return reply.code(400).send({
        error: 'Les services d’un même projet se joignent déjà par leur nom',
        field: 'targetEnvironmentId',
      })
    }
    const targetServices = await deployedAnalysis(target.environment.id)
    const targetService = targetServices?.find((service) => service.name === input.service)
    if (targetServices && !targetService) {
      return reply.code(400).send({
        error: `Le service « ${input.service} » n’existe pas dans le dernier déploiement de ${target.project.name}`,
        field: 'service',
      })
    }
    const kind = linkKind(targetService?.image ?? null)
    const port = LINK_KINDS[kind].port ?? input.port ?? declaredPort(targetService?.ports ?? [])

    // Nom : unique parmi les services et les autres liaisons de cet environnement.
    const links = await linksOf(found.environment.id)
    const existing = links.find(
      (item) =>
        item.network.exposedByEnvironmentId === target.environment.id &&
        item.network.service === input.service,
    )?.network
    const alias = existing?.alias ?? input.alias
    if (!existing) {
      const own = (await deployedAnalysis(found.environment.id))?.map((item) => item.name) ?? []
      if (own.includes(alias) || links.some((item) => item.network.alias === alias)) {
        return reply.code(409).send({
          error: `« ${alias} » est déjà le nom d’un service ou d’une autre liaison de ${found.project.name} : choisissez-en un autre`,
          field: 'alias',
        })
      }
    }

    const running = async (projectSlug: string, environmentSlug: string) =>
      (await host.listContainers(composeProjectName(projectSlug, environmentSlug))).filter(
        (container) => container.state === 'running' && !container.relayFor,
      )

    // Base et utilisateur dédiés : avant tout le reste, pour ne rien laisser à moitié fait.
    let credentials: { user: string; password: string; database: string } | null = null
    if (input.access === 'dedicated') {
      if (!LINK_KINDS[kind].dedicated) {
        return reply.code(400).send({
          error: `${LINK_KINDS[kind].label} : pas de base dédiée à créer`,
          field: 'access',
        })
      }
      const name = input.database ?? linkDatabaseName(found.project.slug)
      let container: { id: string } | undefined
      try {
        container = (await running(target.project.slug, target.environment.slug)).find(
          (item) => item.service === input.service,
        )
      } catch {
        container = undefined
      }
      if (!container) {
        return reply.code(409).send({
          error: `${input.service} de ${target.project.name} n’est pas en marche : démarrez-le pour créer la base`,
          field: 'access',
        })
      }
      const password = randomPassword()
      try {
        await provisionDatabase(
          { runner, dockerSocket, cwd: dataDir },
          container.id,
          kind as 'postgres' | 'mysql' | 'mariadb' | 'mongo',
          name,
          password,
        )
      } catch (error) {
        return reply.code(502).send({
          error: `Création de la base « ${name} » impossible : ${error instanceof Error ? error.message : error}`,
          field: 'access',
        })
      }
      credentials = { user: name, password, database: name }
      await auditAction(
        db,
        request,
        'environment.links.database',
        `${target.project.slug}/${input.service}`,
        {
          database: name,
          for: `${found.project.slug}/${found.environment.slug}`,
        },
      )
    }

    let network = existing
    if (!network) {
      const name = await freeNetworkName(`${found.project.slug}-${alias}`)
      ;[network] = await db
        .insert(sharedNetworks)
        .values({
          name,
          exposedByEnvironmentId: target.environment.id,
          service: input.service,
          alias,
          description: `${found.project.name} → ${input.service} de ${target.project.name}`,
        })
        .returning()
      await auditAction(db, request, 'network.create', name, {
        exposedBy: `${target.project.slug}/${target.environment.slug}`,
        service: input.service,
        alias,
      })
    }
    await db
      .delete(environmentNetworks)
      .where(
        and(
          eq(environmentNetworks.environmentId, params.envId),
          eq(environmentNetworks.sharedNetworkId, network!.id),
        ),
      )
    await db.insert(environmentNetworks).values({
      environmentId: params.envId,
      sharedNetworkId: network!.id,
      services: input.services,
    })
    await auditAction(
      db,
      request,
      'environment.networks.link',
      `${found.project.slug}/${found.environment.slug}`,
      { network: network!.name, service: `${target.project.slug}/${input.service}` },
    )

    // Variable de connexion, secrète, propre à cet environnement.
    if (input.variable) {
      const value = linkUrl(kind, alias, port, credentials)
      await db
        .insert(envVariables)
        .values({
          projectId: found.project.id,
          environmentId: found.environment.id,
          key: input.variable,
          valueEnc: box.encrypt(value),
          secret: true,
        })
        .onConflictDoUpdate({
          target: [envVariables.projectId, envVariables.environmentId, envVariables.key],
          set: { valueEnc: box.encrypt(value), secret: true },
        })
      await auditAction(
        db,
        request,
        'variables.update',
        `${found.project.slug}/${found.environment.slug}`,
        {
          keys: [input.variable],
        },
      )
    }

    // Branchement immédiat des conteneurs en marche ; sinon au prochain déploiement.
    let applied = false
    let detail: string | null = null
    try {
      const exposed = (await running(target.project.slug, target.environment.slug)).filter(
        (container) => container.service === input.service,
      )
      const subscribers = (await running(found.project.slug, found.environment.slug)).filter(
        (container) => !input.services || input.services.includes(container.service),
      )
      if (!exposed.length) {
        detail = `${input.service} de ${target.project.name} n’est pas en marche : la liaison se fera à son prochain démarrage par Vercio (déploiement).`
      } else if (!existing) {
        await host.connectNetwork(sharedNetworkDockerName(network!.name), [
          ...exposed.map((container) => ({ id: container.id, aliases: [alias] })),
          ...subscribers.map((container) => ({ id: container.id, aliases: [] })),
        ])
        applied = true
      } else {
        // Liaison existante : seuls les services nouvellement choisis sont à brancher.
        applied = true
      }
    } catch (error) {
      detail = `Branchement immédiat impossible (${error instanceof Error ? error.message : error}) : la liaison se fera au prochain déploiement.`
    }

    let deploymentId: string | null = null
    if (input.redeploy) {
      const deployment = await app.deployments.request(found.environment.id, {
        trigger: 'user',
        userId: request.user?.id ?? null,
      })
      deploymentId = deployment.id
    }
    const result: EnvironmentLinkResult = {
      network: (await views()).find((view) => view.id === network!.id)!,
      applied,
      detail,
      database: credentials ? { name: credentials.database, user: credentials.user } : null,
      variable: input.variable,
      deploymentId,
    }
    return reply.code(201).send(result)
  })

  /** Abonnements d'un environnement : remplacent les précédents, appliqués au déploiement. */
  app.put('/projects/:id/environments/:envId/networks', admin, async (request, reply) => {
    const params = parseInput(z.object({ id: z.uuid(), envId: z.uuid() }), request.params, reply)
    const input = params && parseInput(environmentNetworksSchema, request.body, reply)
    if (!params || !input) return
    const found = await environmentWithProject(params.envId)
    if (!found || found.project.id !== params.id) {
      return reply.code(404).send({ error: 'Environnement introuvable' })
    }
    const ids = [...new Set(input.subscriptions.map((item) => item.networkId))]
    if (ids.length !== input.subscriptions.length) {
      return reply.code(400).send({ error: 'Réseau en double' })
    }
    const networks = ids.length
      ? await db.select().from(sharedNetworks).where(inArray(sharedNetworks.id, ids))
      : []
    if (networks.length !== ids.length) {
      return reply.code(400).send({ error: 'Réseau partagé introuvable' })
    }
    const own = networks.find((network) => network.exposedByEnvironmentId === params.envId)
    if (own) {
      return reply.code(400).send({
        error: `Cet environnement expose déjà le réseau ${own.name} : il n’a pas à s’y abonner`,
      })
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(environmentNetworks)
        .where(eq(environmentNetworks.environmentId, params.envId))
      if (input.subscriptions.length) {
        await tx.insert(environmentNetworks).values(
          input.subscriptions.map((item) => ({
            environmentId: params.envId,
            sharedNetworkId: item.networkId,
            services: item.services,
          })),
        )
      }
    })
    await auditAction(
      db,
      request,
      'environment.networks.update',
      `${found.project.slug}/${found.environment.slug}`,
      {
        networks: networks.map((network) => network.name),
      },
    )
    return (await views()).filter(
      (view) =>
        view.exposedBy.environmentId === params.envId ||
        view.subscribers.some((subscriber) => subscriber.environmentId === params.envId),
    )
  })
}
