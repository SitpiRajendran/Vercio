import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import { cleanupInputSchema, type CleanupResult, type Health } from '@vercio/shared'
import type { Database } from '../db/client.js'
import type { HostDriver } from '../docker/host-driver.js'
import type { DiskWatcher } from '../notifications/disk.js'
import { VERCIO_VERSION } from '../version.js'
import { auditAction, parseInput } from './helpers.js'

const STARTED_AT = new Date().toISOString()

export const systemRoutes: FastifyPluginAsync<{
  db: Database
  host: HostDriver
  disk: DiskWatcher
}> = async (app, { db, host, disk }) => {
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
