import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyServerOptions } from 'fastify'
import { authPlugin } from './auth/plugin.js'
import { ensureLocalAdmin, setupCode } from './bootstrap.js'
import { OidcService } from './auth/oidc.js'
import { authRoutes } from './auth/routes.js'
import { SessionStore } from './auth/sessions.js'
import type { Config } from './config.js'
import { spawnRunner, type CommandRunner } from './deploy/command.js'
import { DeploymentEngine } from './deploy/engine.js'
import type { Database } from './db/client.js'
import type { HostDriver } from './docker/host-driver.js'
import { StatsSampler } from './docker/stats.js'
import { overviewRoutes } from './routes/overview.js'
import { BackupService } from './backups/service.js'
import type { VercioRelease } from '@vercio/shared'
import { UpdateService } from './updates/service.js'
import { VERCIO_VERSION } from './version.js'
import { backupRoutes } from './routes/backups.js'
import { SecretBox } from './lib/crypto.js'
import { ContainerWatcher } from './notifications/containers.js'
import { DiskWatcher } from './notifications/disk.js'
import { ResourceWatcher } from './notifications/resources.js'
import { NotificationService } from './notifications/service.js'
import { catalogRoutes } from './routes/catalog.js'
import { projectRoutes } from './routes/projects.js'
import { notificationRoutes } from './routes/notifications.js'
import { settingsRoutes } from './routes/settings.js'
import { containerRoutes } from './routes/containers.js'
import { deploymentRoutes } from './routes/deployments.js'
import { eventRoutes } from './routes/events.js'
import { hookRoutes, webhookAdminRoutes } from './routes/webhooks.js'
import { networkRoutes } from './routes/networks.js'
import { systemRoutes } from './routes/system.js'
import { userRoutes } from './routes/users.js'
import { VersionService } from './versions/service.js'
import { WebhookService } from './webhooks/service.js'

export interface AppDeps {
  config: Config
  db: Database
  host: HostDriver
  logger?: FastifyServerOptions['logger']
  /** Exécution des commandes Docker (remplaçable dans les tests). */
  runner?: CommandRunner
  /** Tests : récepteurs de notifications locaux, file relevée plus souvent. */
  notificationOptions?: { allowLoopback?: boolean; manual?: boolean }
  /** Surveillance des conteneurs et du disque (serveur réel ; pas dans les tests de l'API). */
  watchers?: boolean
  /** Après restauration de la base de Vercio (tests : sans arrêter le processus). */
  restart?: () => void
  /** Tests : version en service et dernière release publiée. */
  update?: { version?: string; fetchRelease?: () => Promise<VercioRelease> }
}

declare module 'fastify' {
  interface FastifyInstance {
    deployments: DeploymentEngine
    notifications: NotificationService
    disk: DiskWatcher
    backups: BackupService
  }
}

export async function buildApp({
  config,
  db,
  host,
  logger = false,
  runner = spawnRunner,
  notificationOptions = {},
  watchers = false,
  // Arrêt propre ; Docker relance le conteneur (restart: unless-stopped).
  restart = () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000).unref(),
  update = {},
}: AppDeps) {
  const publicUrl = new URL(config.PUBLIC_URL)
  const app = Fastify({
    logger,
    // Vercio est derrière le reverse proxy amont : l'adresse du client vient de X-Forwarded-For,
    // en ne faisant confiance qu'aux proxys déclarés (sinon l'en-tête serait falsifiable).
    trustProxy:
      typeof config.TRUST_PROXY === 'number'
        ? (_address: string, hop: number) => hop < (config.TRUST_PROXY as number)
        : config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  })

  const sessions = new SessionStore(db, config.SESSION_TTL_HOURS * 3600 * 1000)
  const box = new SecretBox(config.VERCIO_SECRET_KEY)
  const versions = new VersionService(db, box)
  const notifications = new NotificationService(db, box, {
    publicUrl: config.PUBLIC_URL,
    log: app.log,
    ...notificationOptions,
  })
  const engine = new DeploymentEngine(db, box, {
    dataDir: config.VERCIO_DATA_DIR,
    dockerSocket: config.DOCKER_SOCKET,
    runner,
    log: app.log,
    notifications,
    versions,
  })
  await engine.recover()
  notifications.start()
  const disk = new DiskWatcher({
    db,
    notifications,
    log: app.log,
    dataDir: config.VERCIO_DATA_DIR,
  })
  const containers = new ContainerWatcher({ db, host, engine, notifications, log: app.log })
  if (watchers) {
    disk.start()
    containers.start()
  }
  app.addHook('onClose', async () => {
    disk.stop()
    await containers.stop()
    await notifications.stop()
  })
  const backupService = new BackupService({
    db,
    box,
    host,
    runner,
    dataDir: config.VERCIO_DATA_DIR,
    dockerSocket: config.DOCKER_SOCKET,
    notifications,
    log: app.log,
    databaseUrl: config.DATABASE_URL,
    restart,
  })
  await backupService.recover()
  if (watchers) backupService.start()
  app.addHook('onClose', async () => {
    backupService.stop()
    await backupService.idle()
  })
  const updates = new UpdateService({
    db,
    host,
    backups: backupService,
    dataDir: config.VERCIO_DATA_DIR,
    version: update.version ?? VERCIO_VERSION,
    enabled: config.VERCIO_UPDATE_CHECK,
    log: app.log,
    fetchRelease: update.fetchRelease,
  })
  await updates.recover()
  if (watchers) updates.start()
  app.addHook('onClose', async () => updates.stop())
  app.decorate('backups', backupService)
  app.decorate('notifications', notifications)
  app.decorate('disk', disk)
  // Premier administrateur : créé depuis .env (installation sans interface), sinon par la page
  // de premier lancement, protégée par un code.
  await ensureLocalAdmin(db, config, app.log)
  const firstRunCode = await setupCode(db, config, app.log)
  app.decorate('deployments', engine)
  const webhooks = new WebhookService(db, box, engine, versions, app.log, notifications)
  const oidc =
    config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
      ? new OidcService({
          issuer: config.OIDC_ISSUER,
          clientId: config.OIDC_CLIENT_ID,
          clientSecret: config.OIDC_CLIENT_SECRET,
          scopes: config.OIDC_SCOPES,
          rolesClaims: config.OIDC_ROLES_CLAIMS,
          redirectUri: new URL('/api/auth/oidc/callback', publicUrl).href,
          postLogoutRedirectUri: new URL('/connexion', publicUrl).href,
        })
      : null

  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(authPlugin, { sessions, publicOrigin: publicUrl.origin })
  // Terminal web : messages de 64 Kio au plus (saisie, collage).
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })
  const stats = new StatsSampler(host, app.log)
  const resources = new ResourceWatcher({
    db,
    host,
    stats,
    engine,
    notifications,
    log: app.log,
  })
  if (watchers) resources.start()
  app.addHook('onClose', async () => {
    resources.stop()
    stats.stop()
  })

  await app.register(
    async (api) => {
      await api.register(systemRoutes, {
        db,
        host,
        disk,
        updates,
        settings: {
          publicUrl: config.PUBLIC_URL,
          dataDir: config.VERCIO_DATA_DIR,
          databaseUrl: config.DATABASE_URL,
          localAuth: config.VERCIO_LOCAL_AUTH,
          sso: Boolean(config.OIDC_ISSUER),
          updateCheck: config.VERCIO_UPDATE_CHECK,
        },
      })
      await api.register(authRoutes, {
        prefix: '/auth',
        db,
        sessions,
        box,
        publicUrl,
        localEnabled: config.VERCIO_LOCAL_AUTH,
        setupCode: firstRunCode,
        oidc,
        oidcProviderName: config.OIDC_PROVIDER_NAME,
      })
      await api.register(settingsRoutes, { prefix: '/settings', db, box })
      await api.register(notificationRoutes, { prefix: '/settings', db, box, notifications })
      await api.register(userRoutes, {
        prefix: '/settings/users',
        db,
        localEnabled: config.VERCIO_LOCAL_AUTH,
      })
      await api.register(catalogRoutes, { prefix: '/catalog', db, box })
      await api.register(projectRoutes, { prefix: '/projects', db, box, versions, engine, host })
      await api.register(deploymentRoutes, { db, engine })
      await api.register(eventRoutes, { db })
      await api.register(networkRoutes, { db, host })
      await api.register(overviewRoutes, { db, host, stats })
      await api.register(backupRoutes, { db, box, backups: backupService, host })
      await api.register(containerRoutes, {
        db,
        box,
        host,
        stats,
        sessions,
        publicOrigin: publicUrl.origin,
      })
      await api.register(webhookAdminRoutes, { db, box, publicUrl })
      await api.register(hookRoutes, { prefix: '/hooks', webhooks })
      api.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ error: 'Route inconnue' })
      })
    },
    { prefix: '/api' },
  )

  // En production, le serveur sert aussi l'interface compilée (SPA).
  if (config.WEB_DIST_DIR && existsSync(config.WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: config.WEB_DIST_DIR, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      // Routes de la SPA uniquement : un fichier absent (ex. /assets/x.js) reste une 404.
      const path = request.url.split('?')[0] ?? ''
      if (request.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'Route inconnue' })
    })
  }

  // Erreur inattendue : détail dans le journal du serveur, jamais dans la réponse (requêtes SQL,
  // chemins, hôtes internes).
  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
    const status = error.statusCode ?? 500
    if (status < 500) return reply.code(status).send({ error: error.message })
    request.log.error({ err: error }, 'Erreur interne')
    return reply.code(500).send({ error: `Erreur interne (requête ${request.id})` })
  })

  const csp = contentSecurityPolicy(config.WEB_DIST_DIR)
  const https = publicUrl.protocol === 'https:'
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'same-origin')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Content-Security-Policy', csp)
    if (https) reply.header('Strict-Transport-Security', 'max-age=31536000')
  })

  return app
}

/**
 * Politique de contenu : scripts de Vercio seulement (le script de thème intégré à la page est
 * autorisé par son empreinte), aucune page tierce ne peut l'afficher dans un cadre.
 */
function contentSecurityPolicy(webDist: string | undefined): string {
  const hashes: string[] = []
  const index = webDist ? join(webDist, 'index.html') : null
  if (index && existsSync(index)) {
    for (const match of readFileSync(index, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      hashes.push(`'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`)
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // Styles en ligne : positions calculées (carte, menus) et bibliothèques d'interface.
    "style-src 'self' 'unsafe-inline'",
    // data: : logo des projets et QR code de la double authentification.
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
