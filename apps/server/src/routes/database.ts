import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  composeProjectName,
  databaseQuerySchema,
  tableRowsQuerySchema,
  type DatabaseInfo,
  type DatabaseServiceView,
  type TableInfo,
  type TableRows,
} from '@vercio/shared'
import { databaseEngine } from '../backups/databases.js'
import { analyzeCompose } from '../compose/analyze.js'
import {
  columnsQuery,
  DATABASES_QUERY,
  QueryError,
  rowsQueries,
  runSql,
  TABLES_QUERY,
  toColumns,
} from '../database/explorer.js'
import type { Database } from '../db/client.js'
import { deployments, environments, projects } from '../db/schema.js'
import type { CommandRunner } from '../deploy/command.js'
import type { HostDriver } from '../docker/host-driver.js'
import { auditAction, parseInput } from './helpers.js'

class ExplorerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Explorateur de base de données (PostgreSQL) d'un environnement : bases, tables et lignes en
 * lecture (deployers), console SQL (administrateurs, chaque requête journalisée). Tout passe par
 * le conteneur de la base : aucun port à ouvrir.
 */
export const databaseRoutes: FastifyPluginAsync<{
  db: Database
  host: HostDriver
  runner: CommandRunner
  dockerSocket: string
  dataDir: string
}> = async (app, { db, host, runner, dockerSocket, dataDir }) => {
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }
  const envParams = z.object({ id: z.uuid(), envId: z.uuid() })
  const serviceParams = envParams.extend({ service: z.string().min(1).max(100) })
  const options = { runner, dockerSocket, cwd: dataDir }

  async function environment(projectId: string, envId: string) {
    const [row] = await db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, envId), eq(environments.projectId, projectId)))
      .limit(1)
    if (!row) throw new ExplorerError(404, 'Environnement introuvable')
    return row
  }

  /** Services PostgreSQL du dernier déploiement réussi, et leur conteneur en marche. */
  async function services(projectId: string, envId: string) {
    const { project, environment: env } = await environment(projectId, envId)
    const [last] = await db
      .select({ compose: deployments.composeRendered })
      .from(deployments)
      .where(and(eq(deployments.environmentId, env.id), eq(deployments.status, 'succeeded')))
      .orderBy(desc(deployments.createdAt))
      .limit(1)
    const found = last?.compose
      ? analyzeCompose(last.compose).services.filter(
          (service) => service.image && databaseEngine(service.image) === 'postgres',
        )
      : []
    let containers: Awaited<ReturnType<HostDriver['listContainers']>> = []
    try {
      containers = (await host.listContainers(composeProjectName(project.slug, env.slug))).filter(
        (container) => container.state === 'running' && !container.relayFor,
      )
    } catch {
      // Docker injoignable : services affichés comme arrêtés.
    }
    return {
      project,
      environment: env,
      services: found.map((service) => ({
        service: service.name,
        image: service.image,
        container: containers.find((container) => container.service === service.name) ?? null,
      })),
    }
  }

  async function container(projectId: string, envId: string, service: string) {
    const found = (await services(projectId, envId)).services.find(
      (item) => item.service === service,
    )
    if (!found)
      throw new ExplorerError(404, `Pas de base PostgreSQL « ${service} » dans cet environnement`)
    if (!found.container)
      throw new ExplorerError(409, `${service} est arrêté : démarrez-le pour explorer la base`)
    return found.container.id
  }

  async function databaseNames(containerId: string) {
    return (await runSql(options, containerId, 'postgres', DATABASES_QUERY)).rows.map(
      (row) => row[0]!,
    )
  }

  async function checkDatabase(containerId: string, database: string) {
    if (!(await databaseNames(containerId)).includes(database)) {
      throw new ExplorerError(404, `Base « ${database} » introuvable`)
    }
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof ExplorerError)
      return reply.code(error.status).send({ error: error.message })
    if (error instanceof QueryError) return reply.code(400).send({ error: error.message })
    throw error
  }

  app.get('/projects/:id/environments/:envId/database', deployer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    try {
      const result = await services(params.id, params.envId)
      return result.services.map((item): DatabaseServiceView => ({
        service: item.service,
        engine: 'postgres',
        image: item.image,
        running: Boolean(item.container),
      }))
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get(
    '/projects/:id/environments/:envId/database/:service/databases',
    deployer,
    async (request, reply) => {
      const params = parseInput(serviceParams, request.params, reply)
      if (!params) return
      try {
        const id = await container(params.id, params.envId, params.service)
        const result = await runSql(options, id, 'postgres', DATABASES_QUERY)
        return result.rows.map(([name, size]): DatabaseInfo => ({
          name: name!,
          sizeBytes: Number(size) || 0,
        }))
      } catch (error) {
        return fail(reply, error)
      }
    },
  )

  app.get(
    '/projects/:id/environments/:envId/database/:service/tables',
    deployer,
    async (request, reply) => {
      const params = parseInput(serviceParams, request.params, reply)
      const query =
        params &&
        parseInput(z.object({ database: z.string().min(1).max(128) }), request.query, reply)
      if (!params || !query) return
      try {
        const id = await container(params.id, params.envId, params.service)
        await checkDatabase(id, query.database)
        const result = await runSql(options, id, query.database, TABLES_QUERY)
        return result.rows.map(([schema, name, rows, size]): TableInfo => ({
          schema: schema!,
          name: name!,
          rows: Number(rows) || 0,
          sizeBytes: Number(size) || 0,
        }))
      } catch (error) {
        return fail(reply, error)
      }
    },
  )

  app.get(
    '/projects/:id/environments/:envId/database/:service/rows',
    deployer,
    async (request, reply) => {
      const params = parseInput(serviceParams, request.params, reply)
      const query = params && parseInput(tableRowsQuerySchema, request.query, reply)
      if (!params || !query) return
      try {
        const id = await container(params.id, params.envId, params.service)
        await checkDatabase(id, query.database)
        // Table et colonnes vérifiées contre le catalogue avant d'entrer dans une requête.
        const columnInfo = toColumns(
          await runSql(options, id, query.database, columnsQuery(query.schema, query.table)),
        )
        if (!columnInfo.length) throw new ExplorerError(404, `Table « ${query.table} » introuvable`)
        const sort =
          query.sort && columnInfo.some((column) => column.name === query.sort)
            ? query.sort
            : (columnInfo.find((column) => column.primaryKey)?.name ?? null)
        const sql = rowsQueries({
          schema: query.schema,
          table: query.table,
          sort,
          dir: query.dir,
          q: query.q?.trim() || null,
          page: query.page,
          size: query.size,
        })
        const [rows, count] = await Promise.all([
          runSql(options, id, query.database, sql.rows, { maxRows: query.size }),
          runSql(options, id, query.database, sql.count),
        ])
        const result: TableRows = {
          ...rows,
          columnInfo,
          total: Number(count.rows[0]?.[0]) || 0,
          page: query.page,
          size: query.size,
        }
        return result
      } catch (error) {
        return fail(reply, error)
      }
    },
  )

  app.post(
    '/projects/:id/environments/:envId/database/:service/query',
    admin,
    async (request, reply) => {
      const params = parseInput(serviceParams, request.params, reply)
      const input = params && parseInput(databaseQuerySchema, request.body, reply)
      if (!params || !input) return
      try {
        const id = await container(params.id, params.envId, params.service)
        await checkDatabase(id, input.database)
        const { project, environment: env } = await environment(params.id, params.envId)
        await auditAction(
          db,
          request,
          input.write ? 'database.write' : 'database.query',
          `${project.slug}/${env.slug}/${params.service}`,
          {
            database: input.database,
            sql: input.sql.slice(0, 2000),
          },
        )
        return await runSql(options, id, input.database, input.sql, { write: input.write })
      } catch (error) {
        return fail(reply, error)
      }
    },
  )
}
