import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  cleanupInputSchema,
  updateStartSchema,
  type CleanupResult,
  type Health,
  type SystemInfo,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import type { HostDriver } from '../docker/host-driver.js'
import type { DiskWatcher } from '../notifications/disk.js'
import { UpdateError, type UpdateService } from '../updates/service.js'
import { VERCIO_VERSION } from '../version.js'
import { auditAction, parseInput } from './helpers.js'

const STARTED_AT = new Date().toISOString()

export const systemRoutes: FastifyPluginAsync<{
  db: Database
  host: HostDriver
  disk: DiskWatcher
  updates: UpdateService
  /** Réglages montrés dans les infos techniques (jamais de secret). */
  settings: {
    publicUrl: string
    dataDir: string
    databaseUrl: string
    localAuth: boolean
    sso: boolean
    updateCheck: boolean
  }
}> = async (app, { db, host, disk, updates, settings }) => {
  app.get('/health', async (_request, reply): Promise<Health> => {
    const [database, docker] = await Promise.all([
      db.execute(sql`select 1`).then(
        () => true,
        () => false,
      ),
      host.ping(),
    ])
    const health: Health = {
      status: database && docker ? 'ok' : 'degraded',
      version: VERCIO_VERSION,
      database,
      docker,
      startedAt: STARTED_AT,
    }
    // Vercio reste utilisable sans Docker joignable (lecture de l'historique…),
    // mais pas sans base de données.
    reply.code(database ? 200 : 503)
    return health
  })

  // --- Mises à jour de Vercio ----------------------------------------------------------------

  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const adminOnly = { preHandler: app.requireRole('vercio-admin') }

  app.get('/system/update', viewer, async () => updates.status())

  app.post('/system/update/check', adminOnly, async () => updates.check())

  /** Lance la mise à jour : sauvegarde, puis conteneur auxiliaire ; Vercio redémarre ensuite. */
  app.post('/system/update', adminOnly, async (request, reply) => {
    const input = parseInput(updateStartSchema, request.body, reply)
    if (!input) return
    try {
      await updates.update(input.version, request.user!, request.ip)
    } catch (error) {
      if (error instanceof UpdateError) return reply.code(400).send({ error: error.message })
      throw error
    }
    return reply.code(202).send(await updates.status())
  })

  /** Infos techniques (« pour les nerds ») : versions, base de Vercio, Docker, conteneur. */
  app.get('/system/info', adminOnly, async (): Promise<SystemInfo> => {
    const url = new URL(settings.databaseUrl)
    const database: SystemInfo['database'] = {
      host: url.hostname,
      port: url.port || '5432',
      name: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      server: null,
      sizeBytes: null,
      latencyMs: null,
      connections: null,
      migrations: null,
      error: null,
    }
    try {
      const started = performance.now()
      await db.execute(sql`select 1`)
      database.latencyMs = Math.round((performance.now() - started) * 10) / 10
      const [row] = (await db.execute(sql`
        select
          current_setting('server_version') as version,
          pg_database_size(current_database())::bigint as size,
          (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
          (select count(*)::int from drizzle.__drizzle_migrations) as migrations
      `)) as unknown as { version: string; size: string; connections: number; migrations: number }[]
      database.server = row ? `PostgreSQL ${row.version}` : null
      database.sizeBytes = row ? Number(row.size) : null
      database.connections = row?.connections ?? null
      database.migrations = row?.migrations ?? null
    } catch (error) {
      database.error = error instanceof Error ? error.message : String(error)
    }

    let docker: SystemInfo['docker']
    try {
      docker = await host.info()
    } catch {
      docker = { error: 'Démon Docker injoignable' }
    }
    const self = await host.selfContainer().catch(() => null)
    const [counts] = (await db.execute(sql`
      select
        (select count(*)::int from projects) as projects,
        (select count(*)::int from environments) as environments,
        (select count(*)::int from deployments) as deployments,
        (select count(*)::int from users) as users,
        (select count(*)::int from backups) as backups
    `)) as unknown as SystemInfo['counts'][]

    return {
      vercio: {
        version: VERCIO_VERSION,
        startedAt: STARTED_AT,
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        publicUrl: settings.publicUrl,
        dataDir: settings.dataDir,
        localAuth: settings.localAuth,
        sso: settings.sso,
        updateCheck: settings.updateCheck,
      },
      database,
      docker,
      container: self && {
        id: self.id.slice(0, 12),
        image: self.image,
        project: self.labels['com.docker.compose.project'] ?? null,
        service: self.labels['com.docker.compose.service'] ?? null,
        workingDir: self.labels['com.docker.compose.project.working_dir'] ?? null,
        mounts: self.mounts.filter((mount) => mount.destination !== '/var/run/docker.sock'),
      },
      counts: counts!,
    }
  })

  app.get('/system/docker', { preHandler: app.requireRole('vercio-viewer') }, async (_r, reply) => {
    try {
      return await host.info()
    } catch (error) {
      app.log.warn({ err: error }, 'Docker injoignable')
      return reply.code(502).send({ error: 'Démon Docker injoignable' })
    }
  })

  /** Espace disque (tableau de bord) : dernière mesure, ou mesure immédiate. */
  app.get('/system/disk', { preHandler: app.requireRole('vercio-viewer') }, async () => {
    const usage = disk.usage()
    return usage.length ? usage : disk.check()
  })

  /** Tous les conteneurs de l'hôte, y compris ceux lancés hors de Vercio. */
  app.get(
    '/system/containers',
    { preHandler: app.requireRole('vercio-viewer') },
    async (_r, reply) => {
      try {
        return await host.hostContainers()
      } catch (error) {
        app.log.warn({ err: error }, 'Docker injoignable')
        return reply.code(502).send({ error: 'Démon Docker injoignable' })
      }
    },
  )

  const admin = { preHandler: app.requireRole('vercio-admin') }

  /** Espace récupérable, par type de nettoyage. */
  app.get('/system/cleanup', admin, async (_r, reply) => {
    try {
      return await host.cleanupPreview()
    } catch (error) {
      app.log.warn({ err: error }, 'Mesure de l’espace récupérable impossible')
      return reply.code(502).send({ error: 'Démon Docker injoignable' })
    }
  })

  /** Nettoyage : jamais les volumes nommés ni les conteneurs des projets Vercio. */
  app.post('/system/cleanup', admin, async (request, reply) => {
    const input = parseInput(cleanupInputSchema, request.body, reply)
    if (!input) return
    const result: CleanupResult = { targets: {}, totalBytes: 0 }
    // Les images sans tag d'abord : « images inutilisées » les inclut.
    const order = ['containers', 'images-dangling', 'images-unused', 'volumes', 'build-cache']
    const targets = [...new Set(input.targets)].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    for (const target of targets) {
      try {
        const done = await host.cleanup(target)
        result.targets[target] = done
        result.totalBytes += done.bytes
      } catch (error) {
        result.targets[target] = {
          deleted: 0,
          bytes: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    await auditAction(db, request, 'cleanup.run', targets.join(', '), {
      totalBytes: result.totalBytes,
      targets: result.targets,
    })
    return result
  })
}
