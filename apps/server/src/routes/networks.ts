import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import {
  environmentNetworksSchema,
  sharedNetworkDockerName,
  sharedNetworkInputSchema,
  sharedNetworkUpdateSchema,
  type EnvironmentRef,
  type SharedNetworkView,
} from '@vercio/shared'
import { analyzeCompose } from '../compose/analyze.js'
import type { Database } from '../db/client.js'
import {
  deployments,
  environmentNetworks,
  environments,
  projects,
  sharedNetworks,
} from '../db/schema.js'
import type { HostDriver, NetworkState } from '../docker/host-driver.js'
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
export const networkRoutes: FastifyPluginAsync<{ db: Database; host: HostDriver }> = async (
  app,
  { db, host },
) => {
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
