import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import {
  composeProjectName,
  containerActionSchema,
  hasRole,
  TERMINAL_SHELLS,
  terminalSettingsSchema,
  type ContainerInspectView,
  type ContainerLogEvent,
  type ContainerStatsView,
  type ContainerView,
  type Role,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type TerminalSettings,
  type TerminalShell,
} from '@vercio/shared'
import { sessionCookieName, type SessionStore } from '../auth/sessions.js'
import { looksSecret } from '../compose/dotenv.js'
import type { Database } from '../db/client.js'
import { appSettings, deployments, envVariables, environments, projects } from '../db/schema.js'
import { maskSecrets } from '../deploy/render.js'
import type { ExecSession, HostDriver } from '../docker/host-driver.js'
import type { StatsSampler } from '../docker/stats.js'
import type { SecretBox } from '../lib/crypto.js'
import { audit } from '../lib/audit.js'
import { auditAction, parseInput } from './helpers.js'

const ACTION_LABELS = { start: 'démarrage', stop: 'arrêt', restart: 'redémarrage' } as const

const TERMINAL_SETTINGS_KEY = 'terminal'
/** Terminaux ouverts en même temps par un utilisateur. */
const TERMINALS_PER_USER = 5
/** Fermeture d'un terminal sans saisie. */
const TERMINAL_IDLE_MS = 30 * 60_000
/** Vérification de la session (déconnexion, droits retirés) pendant un terminal ouvert. */
const TERMINAL_SESSION_CHECK_MS = 60_000
/** Sortie en attente d'envoi au-delà de laquelle le shell est mis en pause. */
const TERMINAL_BUFFER_LIMIT = 1024 * 1024

const SHELL_COMMANDS: Record<TerminalShell, string[]> = {
  auto: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
  bash: ['bash'],
  sh: ['sh'],
  ash: ['ash'],
  zsh: ['zsh'],
}

/** Conteneurs d'un environnement : état, actions, logs, statistiques, inspection et terminal. */
export const containerRoutes: FastifyPluginAsync<{
  db: Database
  box: SecretBox
  host: HostDriver
  stats: StatsSampler
  sessions: SessionStore
  publicOrigin: string
}> = async (app, { db, box, host, stats, sessions, publicOrigin }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }
  const envParams = z.object({ id: z.uuid(), envId: z.uuid() })
  const containerParams = envParams.extend({ containerId: z.string().regex(/^[a-f0-9]{12,64}$/) })
  const base = '/projects/:id/environments/:envId'

  async function findEnvironment(projectId: string, envId: string) {
    const [row] = await db
      .select({ env: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, envId), eq(environments.projectId, projectId)))
      .limit(1)
    return row ? { ...row, name: composeProjectName(row.project.slug, row.env.slug) } : null
  }

  /** Valeurs des variables secrètes : masquées dans les logs affichés. */
  async function secrets(projectId: string, environmentId: string) {
    return (await secretVariables(projectId, environmentId)).map((row) => row.value)
  }

  async function secretVariables(projectId: string, environmentId: string) {
    const rows = await db
      .select({ key: envVariables.key, valueEnc: envVariables.valueEnc })
      .from(envVariables)
      .where(
        and(
          eq(envVariables.projectId, projectId),
          eq(envVariables.secret, true),
          or(isNull(envVariables.environmentId), eq(envVariables.environmentId, environmentId)),
        ),
      )
    return rows.map((row) => ({ key: row.key, value: box.decrypt(row.valueEnc) }))
  }

  const dockerError = (error: unknown) =>
    `Docker injoignable : ${error instanceof Error ? error.message : String(error)}`

  app.get(`${base}/containers`, viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    try {
      return await host.listContainers(found.name)
    } catch (error) {
      return reply.code(502).send({ error: dockerError(error) })
    }
  })

  app.post(`${base}/containers/actions`, deployer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    const input = params && parseInput(containerActionSchema, request.body, reply)
    if (!params || !input) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })

    const [busy] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, params.envId),
          inArray(deployments.status, ['queued', 'running']),
        ),
      )
      .limit(1)
    if (busy) {
      return reply.code(409).send({
        error: 'Un déploiement est en cours : attendez sa fin avant d’agir sur les conteneurs',
      })
    }

    let containers: ContainerView[]
    try {
      containers = await host.listContainers(found.name)
    } catch (error) {
      return reply.code(502).send({ error: dockerError(error) })
    }
    // Seuls les conteneurs du projet Compose de l'environnement peuvent être visés.
    // Le relais d'un service mis à jour sans coupure suit le service : sans lui, le service
    // en marche resterait injoignable sur ses ports.
    const targets = containers.filter(
      (container) =>
        !input.service ||
        container.service === input.service ||
        container.relayFor === input.service,
    )
    if (targets.length === 0) {
      return reply.code(404).send({
        error: input.service
          ? `Aucun conteneur pour le service ${input.service}`
          : 'Aucun conteneur : l’environnement n’a pas encore été déployé',
      })
    }

    const results = await Promise.allSettled(
      targets.map((container) => host.containerAction(container.id, input.action)),
    )
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`${targets[index]!.name} : ${(result.reason as Error)?.message ?? result.reason}`]
        : [],
    )
    await auditAction(
      db,
      request,
      `container.${input.action}`,
      `${found.project.slug}/${found.env.slug}${input.service ? `/${input.service}` : ''}`,
      { containers: targets.map((container) => container.name), failures },
    )
    if (failures.length) {
      return reply
        .code(502)
        .send({ error: `Échec du ${ACTION_LABELS[input.action]} : ${failures.join(' ; ')}` })
    }
    return host.listContainers(found.name)
  })

  /** Logs en direct (Server-Sent Events) de tous les conteneurs, ou d'un service. */
  app.get(`${base}/logs`, viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    const query =
      params &&
      parseInput(
        z.object({
          service: z.string().min(1).max(100).optional(),
          tail: z.coerce.number().int().min(0).max(2000).default(200),
        }),
        request.query,
        reply,
      )
    if (!params || !query) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    let containers: ContainerView[]
    try {
      containers = (await host.listContainers(found.name)).filter(
        (container) => !query.service || container.service === query.service,
      )
    } catch (error) {
      return reply.code(502).send({ error: dockerError(error) })
    }
    const masked = await secrets(params.id, params.envId)

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (event: ContainerLogEvent) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const controller = new AbortController()
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000)
    request.raw.on('close', () => controller.abort())
    // Session fermée (déconnexion, compte désactivé) : le flux s'arrête, comme le terminal.
    const token = request.cookies[sessionCookieName(publicOrigin.startsWith('https:'))]
    const watchdog = setInterval(() => {
      void (token ? sessions.resolve(token) : Promise.resolve(null))
        .then((current) => {
          if (!current || !hasRole(current.roles, 'vercio-viewer')) controller.abort()
        })
        .catch(() => {})
    }, TERMINAL_SESSION_CHECK_MS)

    await Promise.all(
      containers.map(async (container) => {
        try {
          await host.streamLogs(container.id, {
            tail: query.tail,
            signal: controller.signal,
            onLine: (line) =>
              send({
                type: 'log',
                log: {
                  service: container.service,
                  container: container.name,
                  stream: line.stream,
                  at: line.at,
                  line: maskSecrets(line.line, masked),
                },
              }),
          })
        } catch (error) {
          request.log.warn({ err: error, container: container.name }, 'Lecture des logs impossible')
        }
        send({ type: 'end', container: container.name })
      }),
    )
    clearInterval(heartbeat)
    clearInterval(watchdog)
    raw.end()
  })

  /** Conteneur de l'environnement : null s'il n'en fait pas partie. */
  async function findContainer(name: string, containerId: string) {
    const containers = await host.listContainers(name)
    return containers.find((container) => container.id === containerId) ?? null
  }

  /** Statistiques des conteneurs en marche (historique court, mesuré à la demande). */
  app.get(`${base}/containers/stats`, viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    let running: ContainerView[]
    try {
      running = (await host.listContainers(found.name)).filter(
        (container) => container.state === 'running',
      )
    } catch (error) {
      return reply.code(502).send({ error: dockerError(error) })
    }
    const history = stats.history(running.map((container) => container.id))
    return running.map((container): ContainerStatsView => ({
      id: container.id,
      name: container.name,
      service: container.service,
      samples: history.get(container.id) ?? [],
    }))
  })

  /** Inspection d'un conteneur, variables secrètes masquées. */
  app.get(`${base}/containers/:containerId`, viewer, async (request, reply) => {
    const params = parseInput(containerParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    let details
    try {
      details = (await findContainer(found.name, params.containerId))
        ? await host.containerDetails(params.containerId)
        : null
    } catch (error) {
      return reply.code(502).send({ error: dockerError(error) })
    }
    if (!details) return reply.code(404).send({ error: 'Conteneur introuvable' })

    const variables = await secretVariables(params.id, params.envId)
    const secretKeys = new Set(variables.map((variable) => variable.key))
    const values = variables.map((variable) => variable.value)
    const hidden = (key: string, value: string) =>
      secretKeys.has(key) ||
      looksSecret(key) ||
      values.some((secret) => secret.length >= 4 && value.includes(secret))
    return {
      ...details,
      env: details.env.map(({ key, value }) =>
        hidden(key, value) ? { key, value: null, masked: true } : { key, value, masked: false },
      ),
      command: details.command.map((part) => maskSecrets(part, values)),
      entrypoint: details.entrypoint.map((part) => maskSecrets(part, values)),
      labels: Object.fromEntries(
        Object.entries(details.labels).map(([key, value]) => [key, maskSecrets(value, values)]),
      ),
      health: details.health && {
        ...details.health,
        log: details.health.log.map((entry) => ({
          ...entry,
          output: maskSecrets(entry.output, values),
        })),
      },
    } satisfies ContainerInspectView
  })

  // --- Terminal ---------------------------------------------------------------------------

  async function terminalSettings(): Promise<TerminalSettings> {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, TERMINAL_SETTINGS_KEY))
      .limit(1)
    const parsed = terminalSettingsSchema.safeParse(row?.value)
    return parsed.success ? parsed.data : { deployers: false }
  }

  async function canUseTerminal(roles: Role[]): Promise<boolean> {
    if (hasRole(roles, 'vercio-admin')) return true
    return hasRole(roles, 'vercio-deployer') && (await terminalSettings()).deployers
  }

  app.get('/settings/terminal', viewer, async () => terminalSettings())

  app.put('/settings/terminal', admin, async (request, reply) => {
    const input = parseInput(terminalSettingsSchema, request.body, reply)
    if (!input) return
    await db
      .insert(appSettings)
      .values({ key: TERMINAL_SETTINGS_KEY, value: input })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: input, updatedAt: new Date() } })
    await auditAction(db, request, 'settings.terminal.update', 'terminal', input)
    return input
  })

  /** Terminaux ouverts, par utilisateur. */
  const openTerminals = new Map<string, number>()

  async function terminalGuard(request: FastifyRequest, reply: FastifyReply) {
    // Le navigateur envoie toujours l'origine d'un WebSocket : pas de terminal ouvert depuis un
    // autre site avec le cookie de l'utilisateur.
    if (request.headers.origin !== publicOrigin) {
      return reply.code(403).send({ error: 'Origine de la requête refusée' })
    }
    if (!request.user) return reply.code(401).send({ error: 'Authentification requise' })
    if (!(await canUseTerminal(request.user.roles))) {
      return reply.code(403).send({ error: 'Terminal non autorisé pour votre rôle' })
    }
  }

  const terminalQuery = z.object({
    shell: z.enum(TERMINAL_SHELLS).default('auto'),
    cols: z.coerce.number().int().min(10).max(500).default(80),
    rows: z.coerce.number().int().min(5).max(200).default(24),
  })

  /**
   * Terminal web (`docker exec -it`). Entrée et redimensionnement en JSON, sortie en binaire.
   * Ouverture et fermeture sont inscrites au journal d'audit (pas le contenu de la session).
   */
  app.get(
    `${base}/containers/:containerId/terminal`,
    { websocket: true, preHandler: terminalGuard },
    async (socket: WebSocket, request) => {
      const user = request.user!
      const control = (message: TerminalServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      }
      const fail = (message: string) => {
        control({ type: 'error', message })
        socket.close(1000)
      }

      // Messages reçus avant que le shell soit prêt : rejoués ensuite.
      let exec: ExecSession | null = null
      let lastInput = Date.now()
      const pending: TerminalClientMessage[] = []
      const handle = (message: TerminalClientMessage) => {
        if (!exec) return void (pending.length < 100 && pending.push(message))
        if (message.type === 'input') {
          lastInput = Date.now()
          exec.write(message.data)
        } else {
          void exec.resize(message.cols, message.rows)
        }
      }
      socket.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const message = JSON.parse(data.toString()) as TerminalClientMessage
          if (message.type === 'input' && typeof message.data === 'string') handle(message)
          else if (
            message.type === 'resize' &&
            Number.isInteger(message.cols) &&
            Number.isInteger(message.rows) &&
            message.cols >= 10 &&
            message.cols <= 500 &&
            message.rows >= 5 &&
            message.rows <= 200
          ) {
            handle(message)
          }
        } catch {
          // Message illisible : ignoré.
        }
      })
      let closed = false
      socket.on('close', () => {
        closed = true
        exec?.close()
      })

      const params = containerParams.safeParse(request.params)
      const query = terminalQuery.safeParse(request.query)
      if (!params.success || !query.success) return fail('Requête invalide')
      const found = await findEnvironment(params.data.id, params.data.envId)
      if (!found) return fail('Environnement introuvable')
      let container: ContainerView | null
      try {
        container = await findContainer(found.name, params.data.containerId)
      } catch (error) {
        return fail(dockerError(error))
      }
      if (!container) return fail('Conteneur introuvable dans cet environnement')
      if (container.state !== 'running') return fail('Le conteneur n’est pas en marche')
      if ((openTerminals.get(user.id) ?? 0) >= TERMINALS_PER_USER) {
        return fail(`${TERMINALS_PER_USER} terminaux déjà ouverts : fermez-en un d’abord`)
      }
      if (closed) return

      const target = `${found.project.slug}/${found.env.slug}/${container.service}`
      const startedAt = Date.now()
      const entry = {
        userId: user.id,
        username: user.username,
        ip: request.ip,
        target,
      }
      try {
        exec = await host.exec(container.id, {
          cmd: SHELL_COMMANDS[query.data.shell],
          cols: query.data.cols,
          rows: query.data.rows,
        })
      } catch (error) {
        await audit(db, {
          ...entry,
          action: 'container.terminal',
          success: false,
          details: { container: container.name, shell: query.data.shell, error: String(error) },
        })
        return fail(`Impossible d’ouvrir le terminal : ${dockerError(error)}`)
      }
      openTerminals.set(user.id, (openTerminals.get(user.id) ?? 0) + 1)
      await audit(db, {
        ...entry,
        action: 'container.terminal',
        success: true,
        details: { container: container.name, shell: query.data.shell },
      })
      const session = exec

      session.onData((chunk) => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(chunk, { binary: true })
        // Sortie trop rapide pour le navigateur (cat d'un gros fichier) : le shell attend.
        if (socket.bufferedAmount > TERMINAL_BUFFER_LIMIT) {
          session.pause()
          const wait = setInterval(() => {
            if (
              socket.readyState !== socket.OPEN ||
              socket.bufferedAmount < TERMINAL_BUFFER_LIMIT / 4
            ) {
              clearInterval(wait)
              session.resume()
            }
          }, 50)
        }
      })

      // Session Vercio fermée ou droits retirés, inactivité : le terminal se ferme.
      const token = request.cookies[sessionCookieName(publicOrigin.startsWith('https:'))]
      const watchdog = setInterval(() => {
        void (async () => {
          if (Date.now() - lastInput > TERMINAL_IDLE_MS) {
            return fail('Terminal fermé après 30 minutes sans saisie')
          }
          const current = token ? await sessions.resolve(token) : null
          if (!current || !(await canUseTerminal(current.roles))) {
            fail('Session expirée ou droits retirés : terminal fermé')
          }
        })().catch(() => {})
      }, TERMINAL_SESSION_CHECK_MS)

      control({ type: 'ready' })
      for (const message of pending.splice(0)) handle(message)
      if (closed) session.close()

      const code = await session.exited
      clearInterval(watchdog)
      openTerminals.set(user.id, (openTerminals.get(user.id) ?? 1) - 1)
      if (!openTerminals.get(user.id)) openTerminals.delete(user.id)
      control({ type: 'exit', code })
      if (socket.readyState === socket.OPEN) socket.close(1000)
      await audit(db, {
        ...entry,
        action: 'container.terminal.end',
        success: true,
        details: {
          container: container.name,
          exitCode: code,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        },
      })
    },
  )
}
