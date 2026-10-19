import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { ensureLocalHost } from './bootstrap.js'
import { loadConfig } from './config.js'
import { acquireInstanceLock, createDatabase, runMigrations, waitForDatabase } from './db/client.js'
import { LocalSocketDriver } from './docker/local-socket-driver.js'

const here = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = loadConfig()
  const { db, sql } = createDatabase(config.DATABASE_URL)
  await waitForDatabase(sql, config.DATABASE_URL)
  const releaseLock = await acquireInstanceLock(sql)

  // Les migrations passent avant la construction de l'application, qui lit déjà la base.
  await runMigrations(db, resolve(here, '../drizzle'))
  const host = new LocalSocketDriver(config.DOCKER_SOCKET)
  const app = await buildApp({
    config,
    db,
    host,
    logger: {
      level: config.LOG_LEVEL,
      // Le jeton des webhooks est dans l'URL : il ne doit pas finir dans les journaux.
      serializers: {
        req: (request: { method: string; url: string; ip?: string }) => ({
          method: request.method,
          url: request.url.replace(/^(\/api\/hooks\/(?:gitlab\/|github\/)?)[^/?]+/, '$1***'),
          ip: request.ip,
        }),
      },
      ...(config.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {}),
    },
    watchers: true,
  })

  await ensureLocalHost(db)

  // Docker absent n'empêche pas de démarrer (paramètres, projets), mais rien ne pourra être déployé.
  if (!(await host.ping())) {
    app.log.warn(
      `Docker injoignable via ${config.DOCKER_SOCKET} : vérifiez que Docker est démarré, ` +
        'ou indiquez son socket avec DOCKER_SOCKET (Docker Desktop sur Mac : ~/.docker/run/docker.sock).',
    )
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Arrêt de Vercio')
    // Arrêt borné : un watcher ou une requête lente ne doit pas retenir le verrou de la base.
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 4000).unref())])
    await releaseLock()
    await sql.end({ timeout: 5 })
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    await app.listen({ host: config.HOST, port: config.PORT })
  } catch (error) {
    if ((error as { code?: string }).code === 'EADDRINUSE') {
      throw new Error(
        `le port ${config.PORT} est déjà utilisé par un autre programme : libérez-le ou choisissez-en un autre avec PORT`,
      )
    }
    throw error
  }
}

main().catch((error: unknown) => {
  console.error(`Vercio n'a pas pu démarrer : ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
