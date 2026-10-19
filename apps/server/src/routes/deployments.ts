import type { FastifyPluginAsync } from 'fastify'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  DeploymentDetail,
  DeploymentEvent,
  DeploymentLogLine,
  DeploymentSummary,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  deploymentLogs,
  deployments,
  environmentSources,
  environments,
  projects,
  users,
} from '../db/schema.js'
import { toSummary, type DeploymentEngine } from '../deploy/engine.js'
import { auditAction, parseInput } from './helpers.js'

const FINAL = new Set(['succeeded', 'failed', 'rolled_back', 'interrupted'])

/** Déploiements : lancement, retour arrière, historique et journal en direct. */
export const deploymentRoutes: FastifyPluginAsync<{
  db: Database
  engine: DeploymentEngine
}> = async (app, { db, engine }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
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

  app.get('/projects/:id/environments/:envId/deployments', viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    if (!(await findEnvironment(params.id, params.envId))) {
      return reply.code(404).send({ error: 'Environnement introuvable' })
    }
    const rows = await db
      .select({ deployment: deployments, username: users.username })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.userId))
      .where(eq(deployments.environmentId, params.envId))
      .orderBy(desc(deployments.createdAt))
      .limit(50)
    return rows.map((row) => toSummary(row.deployment, row.username))
  })

  app.post('/projects/:id/environments/:envId/deployments', deployer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    const deployment = await engine.request(params.envId, {
      trigger: 'user',
      userId: request.user!.id,
    })
    await auditAction(db, request, 'deployment.create', `${found.project.slug}/${found.env.slug}`, {
      deploymentId: deployment.id,
    })
    return reply.code(202).send(deployment)
  })

  app.post(
    '/projects/:id/environments/:envId/deployments/:deploymentId/rollback',
    deployer,
    async (request, reply) => {
      const params = parseInput(envParams.extend({ deploymentId: z.uuid() }), request.params, reply)
      if (!params) return
      const found = await findEnvironment(params.id, params.envId)
      if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
      const [target] = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.id, params.deploymentId), eq(deployments.environmentId, params.envId)),
        )
        .limit(1)
      if (!target) return reply.code(404).send({ error: 'Déploiement introuvable' })
      if (target.status !== 'succeeded' || !target.composeRendered) {
        return reply
          .code(400)
          .send({ error: 'Seul un déploiement réussi peut servir de version de retour' })
      }
      // L'environnement est verrouillé sur la version rétablie : un webhook ou un nouveau
      // déploiement ne remet pas en service la version qu'on vient de quitter.
      const versions = target.versions as DeploymentSummary['versions']
      for (const [appSourceId, version] of Object.entries(versions)) {
        await db
          .update(environmentSources)
          .set({ branch: version.branch, ref: version.ref, mode: 'locked' })
          .where(
            and(
              eq(environmentSources.environmentId, params.envId),
              eq(environmentSources.appSourceId, appSourceId),
            ),
          )
      }
      const deployment = await engine.request(params.envId, {
        trigger: 'rollback',
        userId: request.user!.id,
        rollbackOfId: target.id,
      })
      await auditAction(
        db,
        request,
        'deployment.rollback',
        `${found.project.slug}/${found.env.slug}`,
        {
          deploymentId: deployment.id,
          to: target.id,
        },
      )
      return reply.code(202).send(deployment)
    },
  )

  const idParams = z.object({ id: z.uuid() })

  app.get('/deployments/:id', viewer, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const [row] = await db
      .select({
        deployment: deployments,
        username: users.username,
        env: environments,
        project: projects,
      })
      .from(deployments)
      .innerJoin(environments, eq(environments.id, deployments.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .leftJoin(users, eq(users.id, deployments.userId))
      .where(eq(deployments.id, params.id))
      .limit(1)
    if (!row) return reply.code(404).send({ error: 'Déploiement introuvable' })
    const logs = await db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, params.id))
      .orderBy(asc(deploymentLogs.id))
      .limit(5000)
    // Déploiement suivant s'il s'agit du retour automatique déclenché par celui-ci.
    const [next] = await db
      .select({ id: deployments.id, trigger: deployments.trigger })
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, row.deployment.environmentId),
          // Comparaison en SQL : la base garde les microsecondes, JavaScript non.
          sql`${deployments.createdAt} > (select created_at from deployments where id = ${row.deployment.id})`,
        ),
      )
      .orderBy(asc(deployments.createdAt))
      .limit(1)
    const detail: DeploymentDetail = {
      ...toSummary(row.deployment, row.username),
      autoRollbackId: next?.trigger === 'auto_rollback' ? next.id : null,
      projectSlug: row.project.slug,
      environmentName: row.env.name,
      composeOverride: row.deployment.composeOverride,
      logs: logs.map(toLogLine),
    }
    return detail
  })

  /** Journal en direct (Server-Sent Events) : lignes après `after`, puis le flux jusqu'à la fin. */
  app.get('/deployments/:id/events', viewer, async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const query =
      params &&
      parseInput(
        z.object({ after: z.coerce.number().int().min(0).default(0) }),
        request.query,
        reply,
      )
    if (!params || !query) return
    const summary = await engine.summary(params.id)
    if (!summary) return reply.code(404).send({ error: 'Déploiement introuvable' })

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (event: DeploymentEvent) => raw.write(`data: ${JSON.stringify(event)}\n\n`)

    let lastId = query.after
    const queued: DeploymentEvent[] = []
    let ready = false
    const unsubscribe = engine.subscribe(params.id, (event) => {
      if (!ready) return void queued.push(event)
      deliver(event)
    })
    const deliver = (event: DeploymentEvent) => {
      if (event.type === 'log') {
        if (event.log.id <= lastId) return
        lastId = event.log.id
      }
      send(event)
      if (event.type === 'status' && FINAL.has(event.deployment.status)) close()
    }
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000)
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
      raw.end()
    }
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    // Rattrapage : lignes déjà enregistrées, puis état courant, puis événements reçus entre-temps.
    const backlog = await db
      .select()
      .from(deploymentLogs)
      .where(and(eq(deploymentLogs.deploymentId, params.id), gt(deploymentLogs.id, query.after)))
      .orderBy(asc(deploymentLogs.id))
    for (const row of backlog) deliver({ type: 'log', log: toLogLine(row) })
    ready = true
    const current = await engine.summary(params.id)
    for (const event of queued) deliver(event)
    if (current && !raw.writableEnded) deliver({ type: 'status', deployment: current })
  })
}

function toLogLine(row: typeof deploymentLogs.$inferSelect): DeploymentLogLine {
  return {
    id: row.id,
    at: row.at.toISOString(),
    stream: row.stream as DeploymentLogLine['stream'],
    line: row.line,
  }
}
