import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  composeProjectName,
  channelTag,
  sharedNetworkDockerName,
  type ComposeAnalysis,
  type DeploymentEvent,
  type DeploymentLogLine,
  type DeploymentSummary,
  type PublishedPortRule,
} from '@vercio/shared'
import { analyzeCompose } from '../compose/analyze.js'
import type { Database } from '../db/client.js'
import {
  appSources,
  deploymentLogs,
  deployments,
  envVariables,
  environmentNetworks,
  environmentSources,
  environments,
  gitProviders,
  projects,
  registries,
  sharedNetworks,
  trackedServices,
  users,
} from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { deploymentMessage, type DeploymentOutcome } from '../notifications/deployments.js'
import type { NotificationService } from '../notifications/service.js'
import { gitProviderClient } from '../providers/git.js'
import { missingImageMessage } from '../providers/registry-diagnostics.js'
import { registryClientFor, resolveRegistryCredentials } from '../providers/registry-access.js'
import type { CommandRunner } from './command.js'
import { composeFailure, describeComposeFailure } from './diagnostics.js'
import type { VersionService } from '../versions/service.js'
import { addPublishedPorts, pageRelays, withPage } from './published-ports.js'
import {
  formatPortSpec,
  planZeroDowntime,
  readiness,
  renderRelayConfig,
  type Relay,
} from './zero-downtime.js'
import {
  detectPluginDirs,
  dockerPluginDirs,
  envFilePaths,
  maskSecrets,
  registryHost,
  renderDockerConfig,
  renderEnvFile,
  relayConfigPath,
  renderOverride,
} from './render.js'

export interface EngineOptions {
  dataDir: string
  dockerSocket: string
  runner: CommandRunner
  log: FastifyBaseLogger
  /** Versions gardées sur l'hôte par image. */
  keepImages?: number
  /** Historique conservé par environnement. */
  keepDeployments?: number
  notifications?: NotificationService
  /** Versions de la CI : nom (commit ou tag) du dernier build déployé. */
  versions?: VersionService
  /** Attente entre deux vérifications (remplaçable dans les tests). */
  sleep?: (ms: number) => Promise<void>
}

type DeploymentRow = typeof deployments.$inferSelect

/** Variables qu'un projet ne peut pas redéfinir : elles pilotent l'exécution de Docker. */
const RESERVED_VARIABLES = /^(PATH|HOME|DOCKER_.*|COMPOSE_.*)$/

/**
 * Variables qui changeraient le comportement du programme `docker` lui-même (bibliothèque
 * chargée, proxy, certificats…) : écrites dans les fichiers env_file des conteneurs, mais jamais
 * passées au CLI, qui tourne dans Vercio avec l'accès au socket Docker.
 */
const UNSAFE_FOR_CLI =
  /^(LD_.*|DYLD_.*|GCONV_PATH|NODE_OPTIONS|BASH_ENV|ENV|TMPDIR|GODEBUG|GOTRACEBACK|LOCALDOMAIN|RES_OPTIONS|HOSTALIASES|SSL_CERT_(FILE|DIR)|(HTTPS?|NO|ALL)_PROXY)$/i

class DeployError extends Error {
  constructor(
    message: string,
    /** L'échec a eu lieu au démarrage des conteneurs : un retour arrière est utile. */
    readonly afterStart = false,
  ) {
    super(message)
  }
}

/**
 * Moteur de déploiement : un déploiement à la fois par environnement, journal diffusé en direct,
 * images épinglées par digest, retour automatique à la dernière version saine en cas d'échec.
 */
export class DeploymentEngine {
  readonly #events = new EventEmitter()
  readonly #queues = new Map<string, Promise<void>>()
  /** Issue des échecs, lue pour le message de fin de demande. */
  readonly #failures = new Map<string, { afterStart: boolean; rollbackId: string | null }>()
  /** Environnements en cours de déploiement et fin du dernier déploiement (alertes conteneur). */
  readonly #active = new Set<string>()
  readonly #finishedAt = new Map<string, number>()
  /**
   * Chemin absolu : Docker est lancé depuis le dossier de l'environnement, où un DOCKER_CONFIG
   * relatif désignerait un dossier inexistant (ni identifiants, ni plugin Compose).
   */
  readonly #dataDir: string
  #pluginDirs: Promise<string[]> | null = null

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly options: EngineOptions,
  ) {
    this.#events.setMaxListeners(0)
    this.#dataDir = resolve(options.dataDir)
  }

  /**
   * Au démarrage : les déploiements interrompus par un arrêt de Vercio sont marqués comme tels,
   * et signalés (l'environnement a pu rester dans un état intermédiaire).
   */
  async recover(): Promise<void> {
    // Identifiants laissés par un déploiement interrompu (arrêt brutal de Vercio).
    await rm(join(this.#dataDir, 'secrets'), { recursive: true, force: true })
    const interrupted = await this.db
      .update(deployments)
      .set({
        status: 'interrupted',
        finishedAt: new Date(),
        error: 'Vercio a redémarré pendant le déploiement',
      })
      .where(or(eq(deployments.status, 'running'), eq(deployments.status, 'queued')))
      .returning()
    for (const row of interrupted) {
      if (row.trigger !== 'auto_rollback') {
        await this.report({ deployment: row, rollback: null, afterStart: false, interrupted: true })
        continue
      }
      // Retour automatique interrompu : le message porte sur le déploiement qui a échoué.
      const [failed] = await this.db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.environmentId, row.environmentId),
            eq(deployments.status, 'failed'),
            lt(deployments.createdAt, row.createdAt),
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(1)
      if (failed) await this.report({ deployment: failed, rollback: row, afterStart: true })
    }
  }

  /** Un déploiement est en cours, ou s'est terminé il y a moins de `graceMs`. */
  isDeploying(environmentId: string, graceMs = 0): boolean {
    if (this.#active.has(environmentId)) return true
    const finished = this.#finishedAt.get(environmentId)
    return finished !== undefined && Date.now() - finished < graceMs
  }

  subscribe(deploymentId: string, listener: (event: DeploymentEvent) => void): () => void {
    this.#events.on(deploymentId, listener)
    return () => this.#events.off(deploymentId, listener)
  }

  /** Crée un déploiement en attente et le place dans la file de son environnement. */
  async request(
    environmentId: string,
    request: {
      trigger: DeploymentRow['trigger']
      userId?: string | null
      rollbackOfId?: string | null
    },
  ): Promise<DeploymentSummary> {
    const [row] = await this.db
      .insert(deployments)
      .values({
        environmentId,
        trigger: request.trigger,
        userId: request.userId ?? null,
        rollbackOfId: request.rollbackOfId ?? null,
      })
      .returning()
    const previous = this.#queues.get(environmentId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        this.#active.add(environmentId)
        try {
          await this.execute(row!.id)
        } finally {
          this.#active.delete(environmentId)
          this.#finishedAt.set(environmentId, Date.now())
        }
        // Hors de execute() : une notification ne peut ni faire échouer ni annuler le déploiement.
        await this.reportRequest(row!.id)
      })
      .catch((error: unknown) => {
        this.options.log.error(
          { err: error, deploymentId: row!.id },
          'Erreur inattendue du moteur de déploiement',
        )
      })
    this.#queues.set(environmentId, next)
    return this.summary(row!.id) as Promise<DeploymentSummary>
  }

  /** Un déploiement attend déjà son tour : un nouvel appel de webhook peut s'y rattacher. */
  async queued(environmentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.environmentId, environmentId), eq(deployments.status, 'queued')))
      .limit(1)
    return row?.id ?? null
  }

  /**
   * Images qu'un déploiement lancé maintenant épinglerait, comparées à celles du dernier
   * déploiement réussi ou en cours. Sert aux webhooks : on ne redéploie que si une image a changé.
   */
  async imagesChanged(environmentId: string): Promise<{ changed: boolean; tags: string[] }> {
    const context = await this.loadContext(environmentId)
    const { images, versions } = await this.resolveImages(context, async () => {})
    const tags = [...new Set(Object.values(versions).map((version) => version.tag))]
    const [last] = await this.db
      .select({ digests: deployments.digests })
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, environmentId),
          or(eq(deployments.status, 'succeeded'), eq(deployments.status, 'running')),
        ),
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1)
    const previous = (last?.digests ?? {}) as Record<string, string>
    // Seuls les services déjà déployés comptent : un service suivi absent du fichier Compose
    // n'est jamais déployé et ne doit pas provoquer un redéploiement à chaque appel.
    const compared = Object.keys(images).filter((service) => service in previous)
    const changed =
      Object.keys(images).length > 0 &&
      (compared.length === 0 || compared.some((service) => previous[service] !== images[service]))
    return { changed, tags }
  }

  /** Un seul message par demande, retour automatique compris. */
  private async reportRequest(deploymentId: string): Promise<void> {
    const failure = this.#failures.get(deploymentId)
    this.#failures.delete(deploymentId)
    if (failure?.rollbackId) this.#failures.delete(failure.rollbackId)
    if (!this.options.notifications) return
    try {
      const [deployment] = await this.db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1)
      if (!deployment) return
      const [rollback] = failure?.rollbackId
        ? await this.db
            .select()
            .from(deployments)
            .where(eq(deployments.id, failure.rollbackId))
            .limit(1)
        : []
      await this.report({
        deployment,
        rollback: rollback ?? null,
        afterStart: failure?.afterStart ?? false,
      })
    } catch (error) {
      this.options.log.warn({ err: error, deploymentId }, 'Notification de déploiement non créée')
    }
  }

  private async report(outcome: DeploymentOutcome): Promise<void> {
    const notifications = this.options.notifications
    if (!notifications) return
    try {
      const message = await deploymentMessage(this.db, (path) => notifications.link(path), outcome)
      if (message) await notifications.notify(message)
    } catch (error) {
      this.options.log.warn(
        { err: error, deploymentId: outcome.deployment.id },
        'Notification de déploiement non créée',
      )
    }
  }

  /** Attend la fin des déploiements en cours (tests, arrêt propre). */
  async idle(): Promise<void> {
    await Promise.all(this.#queues.values())
  }

  async summary(deploymentId: string): Promise<DeploymentSummary | null> {
    const [row] = await this.db
      .select({ deployment: deployments, username: users.username })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.userId))
      .where(eq(deployments.id, deploymentId))
      .limit(1)
    return row ? toSummary(row.deployment, row.username) : null
  }

  // --- Exécution --------------------------------------------------------------------------

  private async execute(deploymentId: string, failedDeploymentId?: string): Promise<boolean> {
    const [deployment] = await this.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1)
    if (!deployment) return false
    await this.setStatus(deploymentId, { status: 'running', startedAt: new Date() })

    let secrets: string[] = []
    const log = (line: string, stream: DeploymentLogLine['stream'] = 'system') =>
      this.appendLog(deploymentId, maskSecrets(line, secrets), stream)
    let workDir: string | null = null
    let secretsDir: string | null = null
    let envFiles: string[] = []
    /** Projet lancé hors de Vercio, arrêté pour ce déploiement : relancé si celui-ci échoue. */
    let replaced: {
      project: string
      stopped: string[]
      restart: () => Promise<void>
    } | null = null

    try {
      const context = await this.loadContext(deployment.environmentId)
      const { project, environment } = context
      const name = composeProjectName(project.slug, environment.slug)
      const variables = this.variables(context.variables, log)
      secrets = context.variables.filter((v) => v.secret).map((v) => this.box.decrypt(v.valueEnc))

      let compose: string
      let images: Record<string, string>
      let versions: DeploymentSummary['versions']
      const rules = (environment.publishedPorts as PublishedPortRule[]) ?? []
      if (deployment.rollbackOfId) {
        const [target] = await this.db
          .select()
          .from(deployments)
          .where(eq(deployments.id, deployment.rollbackOfId))
          .limit(1)
        if (!target?.composeRendered) throw new DeployError('Déploiement de référence introuvable')
        await log(`▶ Retour à la version du ${target.createdAt.toLocaleString('fr-FR')}`)
        compose = target.composeRendered
        images = target.digests as Record<string, string>
        versions = target.versions as DeploymentSummary['versions']
      } else {
        compose = await this.composeContent(context, log)
        // Ports ouverts depuis Vercio ; un retour arrière reprend le fichier tel quel.
        // Les ports avec page d'attente passent par un relais (plus bas), pas par le service.
        const ports = addPublishedPorts(
          compose,
          rules.filter((rule) => !withPage(rule)),
        )
        compose = ports.compose
        for (const { rule, reason } of ports.skipped) {
          await log(`Port ${rule.published} vers ${rule.service} ignoré : ${reason}`, 'stderr')
        }
        for (const rule of rules) {
          if (!ports.skipped.some((item) => item.rule === rule)) {
            await log(
              `Port ${rule.published}${rule.protocol === 'udp' ? '/udp' : ''} ouvert vers ${rule.service}:${rule.target}${withPage(rule) ? ' (page d’attente si le service ne répond pas)' : ''}`,
            )
          }
        }
        ;({ images, versions } = await this.resolveImages(context, log))
      }

      const analysis = analyzeCompose(compose)
      if (analysis.error) throw new DeployError(`Fichier Compose invalide : ${analysis.error}`)
      for (const service of Object.keys(images)) {
        if (!analysis.services.some((item) => item.name === service)) {
          await log(
            `Le service suivi « ${service} » n’existe plus dans le fichier Compose : ignoré`,
            'stderr',
          )
          delete images[service]
        }
      }
      const networking = await this.sharedNetworking(environment.id, analysis, log)
      // Mise à jour sans coupure : ports des services concernés repris par un relais.
      const zero = planZeroDowntime(compose, project.zeroDowntimeServices)
      for (const item of zero.skipped) {
        await log(
          `Mise à jour sans coupure impossible pour « ${item.service} » (${item.reason}) : remplacement classique`,
          'stderr',
        )
      }
      // Ports avec page d'attente : tenus par un relais, même pendant un redémarrage du service.
      const pages = pageRelays(compose, rules, zero)
      const relays = [...zero.relays, ...pages]
      // Variables qu'aucune ligne du fichier ne transmet : un service seul les reçoit toutes ;
      // dans un projet Compose, c'est au fichier de dire quel service reçoit quoi.
      const unused = analysis.envFile
        ? []
        : Object.keys(variables).filter((key) => !analysis.variables?.includes(key))
      if (unused.length && project.type === 'single') {
        await log(`Variables transmises aux conteneurs : ${unused.join(', ')}`)
      } else if (unused.length) {
        await log(
          `Variables non utilisées par le fichier Compose, donc absentes des conteneurs : ${unused.join(', ')}. Pour en transmettre une à un service : environment: [${unused[0]}] (ou ${unused[0]}: \${${unused[0]}}).`,
          'stderr',
        )
      }
      const override = renderOverride({
        projectSlug: project.slug,
        environmentSlug: environment.slug,
        deploymentId,
        services: analysis.services.map((service) => service.name),
        images,
        restartPolicy: environment.restartPolicy,
        volumes: environment.volumeMap as Record<string, string>,
        ownRestart: analysis.services
          .filter((service) => service.restart !== null)
          .map((service) => service.name),
        sharedNetworks: networking,
        passVariables: project.type === 'single' ? unused : [],
        explicitNetworks: analysis.services
          .filter((service) => service.networks !== null)
          .map((service) => service.name),
        relays: relays.map((relay) => ({
          name: relay.name,
          service: relay.service,
          ports: relay.ports.map(formatPortSpec),
          networks: relay.networks,
        })),
      })
      await this.db
        .update(deployments)
        .set({ versions, digests: images, composeRendered: compose, composeOverride: override })
        .where(eq(deployments.id, deploymentId))

      // Dossier de l'environnement : les chemins relatifs du Compose y sont résolus.
      workDir = join(this.#dataDir, 'envs', project.slug, environment.slug)
      await mkdir(workDir, { recursive: true })
      // Identifiants des registries hors du dossier de l'environnement : les conteneurs qui en
      // montent une partie (`.:/app`) ne doivent pas pouvoir les lire.
      secretsDir = join(this.#dataDir, 'secrets', deploymentId)
      const dockerConfig = join(secretsDir, 'docker')
      await mkdir(dockerConfig, { recursive: true, mode: 0o700 })
      await writeFresh(insideDir(workDir, 'compose.yml'), zero.compose, 0o644)
      await writeFresh(insideDir(workDir, 'compose.vercio.yml'), override, 0o644)
      if (relays.length) await mkdir(join(workDir, '.vercio'), { recursive: true })
      for (const relay of relays) {
        await writeFresh(
          insideDir(workDir, relayConfigPath(relay.name)),
          renderRelayConfig(relay),
          // Lu par nginx dans le conteneur relais.
          0o644,
        )
      }
      // Fichiers env_file du Compose (souvent `.env`) : écrits avec les variables du projet,
      // lisibles par Vercio seul, supprimés à la fin du déploiement.
      envFiles = envFilePaths(compose).map((path) => insideDir(workDir!, path))
      for (const file of envFiles) {
        await mkdir(dirname(file), { recursive: true })
        await writeFresh(file, renderEnvFile(variables))
      }
      if (envFiles.length) {
        await log(`Variables écrites pour env_file : ${envFilePaths(compose).join(', ')}`)
      }
      await writeFresh(
        join(dockerConfig, 'config.json'),
        renderDockerConfig(await this.credentials(context), await this.pluginDirs()),
      )

      const unsafe = Object.keys(variables).filter((key) => UNSAFE_FOR_CLI.test(key))
      if (unsafe.length) {
        await log(
          `Variables transmises aux conteneurs mais pas au programme docker : ${unsafe.join(', ')}`,
        )
      }
      const env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: secretsDir,
        DOCKER_HOST: `unix://${this.options.dockerSocket}`,
        DOCKER_CONFIG: dockerConfig,
        ...Object.fromEntries(Object.entries(variables).filter(([key]) => !unsafe.includes(key))),
      }
      const compose$ = (args: string[], label: string) =>
        this.compose(name, workDir!, env, args, label, log)

      await compose$(['config', '--quiet'], 'Validation du fichier Compose')
      // Le relais (image nginx publique) n'est téléchargé que s'il manque : pas d'appel à
      // Docker Hub à chaque déploiement (limite de débit).
      await compose$(
        relays.length
          ? ['pull', '--quiet', ...analysis.services.map((service) => service.name)]
          : ['pull', '--quiet'],
        'Téléchargement des images',
      )
      for (const network of networking) await this.ensureNetwork(network.name, workDir, env, log)
      if (environment.migratingFrom) {
        replaced = await this.stopReplacedProject(environment.migratingFrom, workDir, env, log)
      }
      const timeout = String(environment.healthcheckTimeoutSeconds)
      // `--wait` attend que chaque conteneur tourne, et soit healthy s'il a un healthcheck.
      const healthchecks = analysis.services.filter((service) => service.hasHealthcheck)
      const waitLabel = healthchecks.length
        ? `attente des healthchecks de ${healthchecks.map((service) => service.name).join(', ')}, ${timeout} s max`
        : `${timeout} s max`
      // Services sans coupure déjà en marche : nouvelle version à côté de l'ancienne.
      const rolling: { service: string; containers: string[] }[] = []
      for (const service of zero.services) {
        const containers = await this.serviceContainers(name, service, workDir, env)
        const stale = containers.filter((container) => container.state !== 'running')
        if (stale.length) {
          await this.docker(['rm', '--force', ...stale.map((item) => item.id)], workDir, env)
        }
        const running = containers.filter((container) => container.state === 'running')
        if (running.length) rolling.push({ service, containers: running.map((item) => item.id) })
      }
      try {
        if (!rolling.length) {
          await compose$(
            ['up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', timeout],
            `Démarrage des conteneurs (${waitLabel})`,
          )
        } else {
          for (const item of rolling) {
            await this.rollout(name, item.service, item.containers, workDir, env, compose$, log, {
              timeoutSeconds: environment.healthcheckTimeoutSeconds,
              relay: zero.relays.find((relay) => relay.service === item.service) ?? null,
            })
          }
          const others = [
            ...analysis.services.map((service) => service.name),
            ...relays.map((relay) => relay.name),
          ].filter((service) => !rolling.some((item) => item.service === service))
          if (others.length) {
            await compose$(
              [
                'up',
                '--detach',
                '--remove-orphans',
                '--no-deps',
                '--wait',
                '--wait-timeout',
                timeout,
                ...others,
              ],
              `Démarrage des autres services (${waitLabel})`,
            )
          }
        }
      } catch (error) {
        if (error instanceof DeployError) throw new DeployError(error.message, true)
        throw new DeployError(error instanceof Error ? error.message : String(error), true)
      }

      if (replaced) {
        await this.removeReplacedProject(replaced.project, workDir, env, log)
        await this.db
          .update(environments)
          .set({ migratingFrom: null })
          .where(eq(environments.id, environment.id))
        replaced = null
      }
      await log('✔ Déploiement réussi')
      await this.setStatus(deploymentId, {
        status: 'succeeded',
        finishedAt: new Date(),
        error: null,
      })
      if (failedDeploymentId) {
        await this.setStatus(failedDeploymentId, { status: 'rolled_back' })
      }
      await this.cleanupImages(images, workDir, env, log)
      await this.pruneHistory(environment.id)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await log(`✖ ${message}`, 'stderr')
      if (replaced) await replaced.restart()
      // Le retour est préparé et annoncé avant de marquer l'échec : le journal en direct le montre.
      const rollbackId =
        error instanceof DeployError && error.afterStart && deployment.trigger !== 'auto_rollback'
          ? await this.prepareAutoRollback(deployment, log)
          : null
      await this.setStatus(deploymentId, {
        status: 'failed',
        finishedAt: new Date(),
        error: maskSecrets(message, secrets),
      })
      this.#failures.set(deploymentId, {
        afterStart: error instanceof DeployError && error.afterStart,
        rollbackId,
      })
      // Exécuté dans le même créneau de la file : aucun autre déploiement ne s'intercale.
      if (rollbackId) await this.execute(rollbackId, deploymentId)
      return false
    } finally {
      // Les identifiants des registries ne restent pas sur le disque.
      if (secretsDir) await rm(secretsDir, { recursive: true, force: true })
      if (workDir) await rm(join(workDir, '.docker'), { recursive: true, force: true })
      for (const file of envFiles) await rm(file, { force: true })
    }
  }

  /**
   * Dossiers de plugins à garder visibles avec le DOCKER_CONFIG temporaire : ceux que Docker
   * annonce (détectés une fois), plus les emplacements usuels (Docker Desktop, Homebrew).
   */
  private pluginDirs(): Promise<string[]> {
    this.#pluginDirs ??= detectPluginDirs(this.options.runner).then((detected) => [
      ...new Set([...detected, ...dockerPluginDirs()]),
    ])
    return this.#pluginDirs
  }

  /** Crée le déploiement de retour vers la dernière version saine, s'il en existe une. */
  private async prepareAutoRollback(
    failed: DeploymentRow,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ): Promise<string | null> {
    const [previous] = await this.db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, failed.environmentId),
          eq(deployments.status, 'succeeded'),
          ne(deployments.id, failed.id),
        ),
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1)
    if (!previous) {
      await log('Aucune version précédente saine : pas de retour automatique.')
      return null
    }
    const [rollback] = await this.db
      .insert(deployments)
      .values({
        environmentId: failed.environmentId,
        trigger: 'auto_rollback',
        rollbackOfId: previous.id,
      })
      .returning()
    await log(`↺ Retour automatique à la dernière version saine (déploiement ${rollback!.id})`)
    return rollback!.id
  }

  private async compose(
    name: string,
    cwd: string,
    env: Record<string, string>,
    args: string[],
    label: string,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    await log(`▶ ${label}`)
    const full = [
      'compose',
      '--ansi',
      'never',
      '--progress',
      'plain',
      '--project-name',
      name,
      '--file',
      'compose.yml',
      '--file',
      'compose.vercio.yml',
      ...args,
    ]
    let pending = Promise.resolve()
    let pluginMissing = false
    // Dernières lignes de sortie : la cause de l'échec y figure.
    const tail: string[] = []
    const { code } = await this.options.runner.run('docker', full, {
      cwd,
      env,
      // Les lignes sont enregistrées dans l'ordre, sans bloquer la lecture du processus.
      onLine: (line, stream) => {
        if (line.includes('unknown flag: --ansi')) pluginMissing = true
        tail.push(line)
        if (tail.length > 200) tail.shift()
        pending = pending.then(() => log(line, stream))
      },
    })
    await pending
    if (code !== 0) {
      if (pluginMissing) {
        const dirs = await this.pluginDirs()
        await log(
          `Docker Compose est introuvable pour la CLI docker lancée par Vercio (« unknown flag: --ansi »). ` +
            `Dossiers de plugins transmis : ${dirs.length ? dirs.join(', ') : 'aucun détecté'}. ` +
            'Vérifiez que « docker compose version » fonctionne sur l’hôte de Vercio, avec le même utilisateur.',
          'stderr',
        )
      }
      const failure = composeFailure(tail)
      if (failure) {
        const occupant =
          failure.kind === 'port_allocated' ? await this.portOccupant(failure.port, cwd, env) : null
        throw new DeployError(`${label} : ${describeComposeFailure(failure, occupant)}`)
      }
      throw new DeployError(`${label} : échec (code ${code})`)
    }
  }

  /** Conteneurs d'un service du projet Compose, arrêtés compris. */
  private async serviceContainers(
    project: string,
    service: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ id: string; state: string; name: string }[]> {
    const { code, out, errors } = await this.docker(
      [
        'ps',
        '--all',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=com.docker.compose.service=${service}`,
        '--format',
        '{{.ID}} {{.State}} {{.Names}}',
      ],
      cwd,
      env,
    )
    if (code !== 0)
      throw new DeployError(`Conteneurs de ${service} illisibles : ${errors.join(' ')}`)
    return out.map((line) => {
      const [id = '', state = '', name = ''] = line.split(' ')
      return { id, state, name }
    })
  }

  /**
   * Mise à jour sans coupure d'un service : la nouvelle version démarre à côté de l'ancienne
   * (`--scale` sans recréer), puis l'ancienne s'arrête une fois la nouvelle prête. Si la
   * nouvelle ne démarre pas, elle est supprimée et l'ancienne n'a jamais cessé de répondre.
   */
  private async rollout(
    project: string,
    service: string,
    old: string[],
    cwd: string,
    env: Record<string, string>,
    compose$: (args: string[], label: string) => Promise<void>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
    { timeoutSeconds, relay }: { timeoutSeconds: number; relay: Relay | null },
  ): Promise<void> {
    const freshContainers = async () =>
      (await this.serviceContainers(project, service, cwd, env)).filter(
        (container) => !old.includes(container.id),
      )
    const fresh = async () => (await freshContainers()).map((container) => container.id)
    const discard = async (reason: string): Promise<never> => {
      const created = await fresh().catch(() => [])
      if (created.length) await this.docker(['rm', '--force', ...created], cwd, env)
      throw new DeployError(`${service} : ${reason} ; l’ancienne version est restée en service`)
    }
    try {
      await compose$(
        [
          'up',
          '--detach',
          '--no-deps',
          '--no-recreate',
          '--scale',
          `${service}=${old.length * 2}`,
          service,
        ],
        `Mise à jour sans coupure de ${service} : nouvelle version démarrée à côté de l’ancienne`,
      )
    } catch (error) {
      return discard(error instanceof Error ? error.message : String(error))
    }
    const created = await freshContainers()
    if (!created.length) return discard('la nouvelle version n’a pas été créée')
    const ready = await this.waitReady(
      created.map((container) => container.id),
      timeoutSeconds,
      cwd,
      env,
    )
    if (!ready.ok) return discard(ready.reason)
    // Le relais n'envoie plus rien à l'ancienne version (rechargement nginx sans coupure) ;
    // les requêtes en cours se terminent avant son arrêt.
    const reloaded = relay
      ? await this.reloadRelay(project, relay, created[0]!.name, cwd, env, log)
      : false
    await log(`Bascule de ${service} : la nouvelle version répond, arrêt de l’ancienne`)
    await this.docker(['stop', '--time', '15', ...old], cwd, env)
    await this.docker(['rm', '--force', ...old], cwd, env)
    // Ancienne version partie : le relais suit de nouveau le service par son nom.
    if (reloaded && relay) await this.reloadRelay(project, relay, relay.service, cwd, env, log)
    await log(`✔ ${service} mis à jour sans coupure`)
  }

  /** Réécrit la cible du relais et recharge nginx ; false si le relais ne tourne pas encore. */
  private async reloadRelay(
    project: string,
    relay: Relay,
    upstream: string,
    cwd: string,
    env: Record<string, string>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ): Promise<boolean> {
    const { out } = await this.docker(
      [
        'ps',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=vercio.relay-for=${relay.service}`,
        '--filter',
        'status=running',
      ],
      cwd,
      env,
    )
    // Le fichier est réécrit en place : le relais le voit par son montage.
    await writeFile(join(cwd, relayConfigPath(relay.name)), renderRelayConfig(relay, upstream))
    if (!out[0]) return false
    const { code, errors } = await this.docker(['exec', out[0], 'nginx', '-s', 'reload'], cwd, env)
    if (code !== 0) {
      await log(`Relais de ${relay.service} non rechargé : ${errors.join(' ')}`, 'stderr')
      return false
    }
    // Laisse aux workers nginx le temps de prendre la nouvelle configuration.
    await (this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(1000)
    return true
  }

  /** Attend que les conteneurs soient healthy (ou en marche 3 s, sans healthcheck). */
  private async waitReady(
    ids: string[],
    timeoutSeconds: number,
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const runningSince = new Map<string, number>()
    let elapsed = 0
    while (elapsed <= timeoutSeconds * 1000) {
      const { out } = await this.docker(
        [
          'inspect',
          '--format',
          '{{.Id}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
          ...ids,
        ],
        cwd,
        env,
      )
      const states = out.map((line) => {
        const [id = '', status = '', health = ''] = line.split(' ')
        return { id, state: readiness(status, health), status, health }
      })
      const failed = states.find((item) => item.state === 'failed')
      if (failed) {
        return {
          ok: false,
          reason:
            failed.health === 'unhealthy'
              ? 'la nouvelle version est unhealthy'
              : `la nouvelle version s’est arrêtée (${failed.status})`,
        }
      }
      for (const item of states) {
        if (item.state === 'running' && !runningSince.has(item.id))
          runningSince.set(item.id, elapsed)
      }
      const done =
        states.length === ids.length &&
        states.every(
          (item) =>
            item.state === 'ready' ||
            (item.state === 'running' && elapsed - (runningSince.get(item.id) ?? elapsed) >= 3000),
        )
      if (done) return { ok: true }
      await sleep(1000)
      elapsed += 1000
    }
    return { ok: false, reason: `la nouvelle version n’est pas prête après ${timeoutSeconds} s` }
  }

  /** Commande docker dont on lit la sortie (identifiants de conteneurs, réseaux). */
  private async docker(args: string[], cwd: string, env: Record<string, string>) {
    const out: string[] = []
    const errors: string[] = []
    const { code } = await this.options.runner.run('docker', args, {
      cwd,
      env,
      timeoutMs: 120_000,
      onLine: (line, stream) => {
        if (!line.trim()) return
        if (stream === 'stdout') out.push(line.trim())
        else errors.push(line.trim())
      },
    })
    return { code, out, errors }
  }

  /**
   * Réseaux partagés de l'environnement : ceux qu'il expose (le service y porte l'alias) et ceux
   * auxquels il est abonné (ses services les rejoignent pour atteindre l'alias).
   */
  private async sharedNetworking(
    environmentId: string,
    analysis: ComposeAnalysis,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    const exposed = await this.db
      .select()
      .from(sharedNetworks)
      .where(eq(sharedNetworks.exposedByEnvironmentId, environmentId))
    const subscribed = await this.db
      .select({
        network: sharedNetworks,
        services: environmentNetworks.services,
        exposer: environments,
        project: projects,
      })
      .from(environmentNetworks)
      .innerJoin(sharedNetworks, eq(sharedNetworks.id, environmentNetworks.sharedNetworkId))
      .innerJoin(environments, eq(environments.id, sharedNetworks.exposedByEnvironmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(environmentNetworks.environmentId, environmentId))
    const byName = new Map(analysis.services.map((service) => [service.name, service]))
    const result: { name: string; services: Record<string, string[]> }[] = []

    for (const network of exposed) {
      const dockerName = sharedNetworkDockerName(network.name)
      const service = byName.get(network.service)
      if (!service) {
        throw new DeployError(
          `Le service « ${network.service} », exposé sur le réseau partagé ${network.name}, n’existe plus dans le fichier Compose : modifiez le réseau dans Réseaux partagés`,
        )
      }
      if (service.networkMode) {
        throw new DeployError(
          `Le service « ${network.service} » utilise network_mode: ${service.networkMode} : il ne peut pas être exposé sur le réseau partagé ${network.name}`,
        )
      }
      result.push({ name: dockerName, services: { [network.service]: [network.alias] } })
      await log(
        `Réseau partagé ${dockerName} : « ${network.service} » joignable sous le nom ${network.alias}`,
      )
    }

    for (const { network, services, exposer, project } of subscribed) {
      const dockerName = sharedNetworkDockerName(network.name)
      const wanted = services ?? analysis.services.map((service) => service.name)
      const attached: string[] = []
      for (const name of wanted) {
        const service = byName.get(name)
        if (!service) {
          await log(
            `Réseau partagé ${dockerName} : service « ${name} » absent du fichier Compose, ignoré`,
            'stderr',
          )
        } else if (service.networkMode) {
          // Explicitement demandé : signalé ; « tous les services » : ignoré sans bruit.
          if (services) {
            await log(
              `Réseau partagé ${dockerName} : « ${name} » utilise network_mode, ignoré`,
              'stderr',
            )
          }
        } else {
          attached.push(name)
        }
      }
      if (!attached.length) continue
      result.push({
        name: dockerName,
        services: Object.fromEntries(attached.map((name) => [name, []])),
      })
      await log(
        `Réseau partagé ${dockerName} : ${attached.join(', ')} joignent ${network.alias} (${project.slug} / ${exposer.slug})`,
      )
    }
    return result
  }

  /** Crée le réseau partagé s'il n'existe pas encore (premier environnement déployé). */
  private async ensureNetwork(
    name: string,
    cwd: string,
    env: Record<string, string>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    if (
      (await this.docker(['network', 'inspect', '--format', '{{.Name}}', name], cwd, env)).code ===
      0
    ) {
      return
    }
    const created = await this.docker(
      [
        'network',
        'create',
        '--driver',
        'bridge',
        '--label',
        'vercio.managed=true',
        '--label',
        `vercio.shared-network=${name}`,
        name,
      ],
      cwd,
      env,
    )
    if (created.code === 0) {
      await log(`Réseau partagé ${name} créé`)
      return
    }
    // Créé entre-temps par le déploiement d'un autre environnement.
    if (
      (await this.docker(['network', 'inspect', '--format', '{{.Name}}', name], cwd, env)).code ===
      0
    ) {
      return
    }
    throw new DeployError(
      `Création du réseau partagé ${name} impossible : ${created.errors.join(' ') || `code ${created.code}`}`,
    )
  }

  /**
   * Reprise d'un projet lancé hors de Vercio : ses conteneurs sont arrêtés (ports libérés), pas
   * supprimés, pour pouvoir les relancer si le déploiement échoue.
   */
  private async stopReplacedProject(
    project: string,
    cwd: string,
    env: Record<string, string>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    const filter = ['--filter', `label=com.docker.compose.project=${project}`]
    const running = (await this.docker(['ps', '-q', ...filter], cwd, env)).out
    await log(
      `▶ Reprise du projet « ${project} » lancé hors de Vercio : arrêt de ses ${running.length} conteneur(s) en marche (supprimés si le déploiement réussit, relancés sinon)`,
    )
    if (running.length) {
      const stop = await this.docker(['stop', ...running], cwd, env)
      if (stop.code !== 0) {
        throw new DeployError(
          `Arrêt de l’ancien projet « ${project} » impossible : ${stop.errors.at(-1) ?? `code ${stop.code}`}`,
        )
      }
    }
    return {
      project,
      stopped: running,
      restart: async () => {
        if (!running.length) return
        const start = await this.docker(['start', ...running], cwd, env)
        await log(
          start.code === 0
            ? `↺ Ancien projet « ${project} » relancé : il tourne comme avant le déploiement`
            : `Relance de l’ancien projet « ${project} » impossible : ${start.errors.at(-1) ?? `code ${start.code}`} (docker start ${running.join(' ')})`,
          start.code === 0 ? 'system' : 'stderr',
        )
      },
    }
  }

  /** Après un premier déploiement réussi : conteneurs et réseaux de l'ancien projet supprimés, volumes gardés. */
  private async removeReplacedProject(
    project: string,
    cwd: string,
    env: Record<string, string>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    const filter = ['--filter', `label=com.docker.compose.project=${project}`]
    const containers = (await this.docker(['ps', '-aq', ...filter], cwd, env)).out
    if (containers.length) await this.docker(['rm', '-f', ...containers], cwd, env)
    const networks = (await this.docker(['network', 'ls', '-q', ...filter], cwd, env)).out
    if (networks.length) await this.docker(['network', 'rm', ...networks], cwd, env)
    await log(
      `Ancien projet « ${project} » remplacé : ${containers.length} conteneur(s) et ${networks.length} réseau(x) supprimés ; ses volumes sont conservés.`,
    )
  }

  /** Conteneur qui publie déjà ce port sur l'hôte (souvent le même projet lancé hors Vercio). */
  private async portOccupant(
    port: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<string | null> {
    const names: string[] = []
    try {
      await this.options.runner.run(
        'docker',
        ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'],
        {
          cwd,
          env,
          timeoutMs: 10_000,
          onLine: (line, stream) => {
            if (stream === 'stdout' && line.trim()) names.push(line.trim())
          },
        },
      )
    } catch {
      return null
    }
    return names[0] ?? null
  }

  // --- Préparation -----------------------------------------------------------------------

  private async loadContext(environmentId: string) {
    const [row] = await this.db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(environments.id, environmentId))
      .limit(1)
    if (!row) throw new DeployError('Environnement introuvable')
    const [sources, envSources, tracked, variables] = await Promise.all([
      this.db
        .select({ source: appSources, provider: gitProviders })
        .from(appSources)
        .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
        .where(eq(appSources.projectId, row.project.id)),
      this.db
        .select()
        .from(environmentSources)
        .where(eq(environmentSources.environmentId, environmentId)),
      this.db
        .select({ service: trackedServices, registry: registries })
        .from(trackedServices)
        .innerJoin(registries, eq(registries.id, trackedServices.registryId))
        .where(eq(trackedServices.projectId, row.project.id)),
      this.db
        .select()
        .from(envVariables)
        .where(
          and(
            eq(envVariables.projectId, row.project.id),
            or(isNull(envVariables.environmentId), eq(envVariables.environmentId, environmentId)),
          ),
        ),
    ])
    return { ...row, sources, envSources, tracked, variables }
  }

  /** Variables partagées, remplacées par celles de l'environnement. */
  private variables(
    rows: (typeof envVariables.$inferSelect)[],
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ): Record<string, string> {
    const result: Record<string, string> = {}
    const origin = new Map<string, string>()
    const ordered = [...rows].sort(
      (a, b) => Number(a.environmentId !== null) - Number(b.environmentId !== null),
    )
    for (const row of ordered) {
      if (RESERVED_VARIABLES.test(row.key)) {
        void log(`Variable ${row.key} réservée à Vercio : ignorée`, 'stderr')
        continue
      }
      result[row.key] = this.box.decrypt(row.valueEnc)
      origin.set(
        row.key,
        row.environmentId === null
          ? 'partagée'
          : origin.has(row.key)
            ? 'environnement, remplace la partagée'
            : 'environnement',
      )
    }
    // Les noms et leur origine seulement, jamais les valeurs.
    if (origin.size) {
      void log(`Variables : ${[...origin].map(([key, from]) => `${key} (${from})`).join(', ')}`)
    }
    return result
  }

  private gitClient(provider: typeof gitProviders.$inferSelect) {
    return gitProviderClient({
      type: provider.type,
      url: provider.webUrl,
      token: this.box.decrypt(provider.tokenEnc),
      caCertificate: provider.caCertificate,
    })
  }

  private async composeContent(
    context: Awaited<ReturnType<DeploymentEngine['loadContext']>>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ): Promise<string> {
    const { project } = context
    if (project.composeSource === 'inline') return project.composeInline ?? ''
    const entry = context.sources.find((item) => item.source.id === project.composeAppSourceId)
    if (!entry) throw new DeployError('Source du fichier Compose introuvable')
    // Le fichier est lu sur la branche de l'environnement.
    const branch =
      context.envSources.find((item) => item.appSourceId === entry.source.id)?.branch ??
      entry.source.defaultBranch
    const path = project.composePath ?? 'docker-compose.yml'
    await log(`▶ Lecture de ${path} sur ${entry.source.repository} (${branch})`)
    try {
      return await this.gitClient(entry.provider).getFile(entry.source.repository, path, branch)
    } catch (error) {
      throw new DeployError(
        `Lecture du fichier Compose impossible : ${error instanceof Error ? error.message : error}`,
      )
    }
  }

  private async resolveImages(
    context: Awaited<ReturnType<DeploymentEngine['loadContext']>>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    const images: Record<string, string> = {}
    const versions: DeploymentSummary['versions'] = {}
    const clients = new Map<string, ReturnType<typeof registryClientFor>>()
    for (const envSource of context.envSources) {
      const entry = context.sources.find((item) => item.source.id === envSource.appSourceId)
      if (!entry) continue
      const { source } = entry
      const tag = envSource.ref === 'latest' ? channelTag(envSource.branch, source) : envSource.ref
      versions[source.id] = { branch: envSource.branch, ref: envSource.ref, tag }
      await log(`▶ Résolution de ${source.repository} : ${tag}`)
      const forSource = context.tracked
        .filter((item) => item.service.appSourceId === source.id)
        .sort((a, b) => a.service.serviceName.localeCompare(b.service.serviceName))
      for (const { service, registry } of forSource) {
        if (!clients.has(registry.id)) {
          clients.set(
            registry.id,
            registryClientFor(this.db, this.box, {
              ...registry,
              password: registry.passwordEnc ? this.box.decrypt(registry.passwordEnc) : null,
            }),
          )
        }
        const client = await clients.get(registry.id)!
        const info = await client.getTag(service.imageRepository, tag)
        if (!info) {
          throw new DeployError(
            await missingImageMessage(client, {
              service: service.serviceName,
              registryName: registry.name,
              image: `${registryHost(registry.url)}/${service.imageRepository}`,
              path: service.imageRepository,
              tag,
            }),
          )
        }
        images[service.serviceName] =
          `${registryHost(registry.url)}/${service.imageRepository}@${info.digest}`
        await log(`  ${service.serviceName} → ${images[service.serviceName]}`)
      }
      // Dernier build (tag mobile `prod`, `latest`…) : le commit ou le tag de version qui a
      // produit exactement ces images, pour l'historique.
      if (envSource.ref === 'latest' && forSource.length && this.options.versions) {
        try {
          const choices = await this.options.versions.choices(source.id, envSource.branch)
          const latest = choices?.latest
          const same =
            latest?.version &&
            latest.images.every((image) => images[image.serviceName]?.endsWith(`@${image.digest}`))
          if (same) {
            versions[source.id]!.version = latest.version!.name
            await log(`  = ${latest.version!.name} (${latest.version!.commit.shortSha})`)
          }
        } catch {
          // Pas de nom de version : l'historique affiche le tag.
        }
      }
    }
    return { images, versions }
  }

  private async credentials(context: Awaited<ReturnType<DeploymentEngine['loadContext']>>) {
    const result: { host: string; username: string; password: string }[] = []
    const seen = new Set<string>()
    for (const { registry } of context.tracked) {
      if (seen.has(registry.id)) continue
      seen.add(registry.id)
      const { username, password } = await resolveRegistryCredentials(this.db, this.box, {
        ...registry,
        password: registry.passwordEnc ? this.box.decrypt(registry.passwordEnc) : null,
      })
      if (password)
        result.push({ host: registryHost(registry.url), username: username ?? 'vercio', password })
    }
    return result
  }

  // --- Après déploiement -----------------------------------------------------------------

  /**
   * Garde sur l'hôte les images des N dernières versions déployées (tous environnements),
   * supprime les autres versions de ces dépôts d'images si aucun conteneur ne les utilise.
   */
  private async cleanupImages(
    images: Record<string, string>,
    cwd: string,
    env: Record<string, string>,
    log: (line: string, stream?: DeploymentLogLine['stream']) => Promise<void>,
  ) {
    const keep = this.options.keepImages ?? 5
    const repositories = [...new Set(Object.values(images).map((ref) => ref.split('@')[0]!))]
    if (repositories.length === 0) return
    const recent = await this.db
      .select({ digests: deployments.digests })
      .from(deployments)
      .where(eq(deployments.status, 'succeeded'))
      .orderBy(desc(deployments.createdAt))
      .limit(200)
    for (const repository of repositories) {
      const kept = new Set<string>()
      for (const row of recent) {
        for (const ref of Object.values(row.digests as Record<string, string>)) {
          if (ref.startsWith(`${repository}@`) && kept.size < keep) kept.add(ref.split('@')[1]!)
        }
      }
      const listing: string[] = []
      await this.options.runner.run(
        'docker',
        ['image', 'ls', '--digests', '--format', '{{.Digest}} {{.ID}}', repository],
        {
          cwd,
          env,
          onLine: (line) => listing.push(line),
        },
      )
      const toRemove = [
        ...new Set(
          listing
            .map((line) => line.split(' '))
            .filter(([digest]) => digest && digest !== '<none>' && !kept.has(digest))
            .map(([, id]) => id!),
        ),
      ]
      for (const id of toRemove) {
        const { code } = await this.options.runner.run('docker', ['image', 'rm', id], {
          cwd,
          env,
          onLine: () => {},
        })
        if (code === 0) await log(`Ancienne image supprimée : ${repository} (${id})`)
      }
    }
  }

  private async pruneHistory(environmentId: string) {
    const keep = this.options.keepDeployments ?? 50
    // Entièrement en SQL : les dates gardent leur précision à la microseconde.
    await this.db.execute(sql`
      delete from deployments where id in (
        select id from deployments where environment_id = ${environmentId}
        order by created_at desc offset ${keep}
      )`)
  }

  /**
   * Arrête et supprime les conteneurs d'un environnement (les volumes sont conservés).
   * Ne lève jamais d'erreur : la suppression dans Vercio ne doit pas être bloquée par Docker.
   */
  async destroy(projectSlug: string, environmentSlug: string): Promise<void> {
    const name = composeProjectName(projectSlug, environmentSlug)
    const lines: string[] = []
    try {
      await mkdir(this.#dataDir, { recursive: true })
      const { code } = await this.options.runner.run(
        'docker',
        ['compose', '--ansi', 'never', '--project-name', name, 'down', '--remove-orphans'],
        {
          cwd: this.#dataDir,
          env: { PATH: process.env.PATH ?? '', DOCKER_HOST: `unix://${this.options.dockerSocket}` },
          onLine: (line) => lines.push(line),
        },
      )
      if (code !== 0)
        this.options.log.warn(
          { name, output: lines.slice(-5) },
          'Arrêt de l’environnement en échec',
        )
      await rm(join(this.#dataDir, 'envs', projectSlug, environmentSlug), {
        recursive: true,
        force: true,
      })
    } catch (error) {
      this.options.log.warn({ err: error, name }, 'Arrêt de l’environnement impossible')
    }
  }

  // --- Persistance -----------------------------------------------------------------------

  private async appendLog(deploymentId: string, line: string, stream: DeploymentLogLine['stream']) {
    const [row] = await this.db
      .insert(deploymentLogs)
      .values({ deploymentId, line: line.slice(0, 4000), stream })
      .returning()
    this.#events.emit(deploymentId, {
      type: 'log',
      log: { id: row!.id, at: row!.at.toISOString(), stream, line: row!.line },
    } satisfies DeploymentEvent)
  }

  private async setStatus(deploymentId: string, values: Partial<typeof deployments.$inferInsert>) {
    await this.db.update(deployments).set(values).where(eq(deployments.id, deploymentId))
    const summary = await this.summary(deploymentId)
    if (summary)
      this.#events.emit(deploymentId, {
        type: 'status',
        deployment: summary,
      } satisfies DeploymentEvent)
  }
}

export function toSummary(row: DeploymentRow, username: string | null): DeploymentSummary {
  return {
    id: row.id,
    environmentId: row.environmentId,
    trigger: row.trigger,
    status: row.status,
    username,
    versions: row.versions as DeploymentSummary['versions'],
    images: row.digests as Record<string, string>,
    error: row.error,
    rollbackOfId: row.rollbackOfId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** Chemin résolu dans `dir` : refuse `../` et les chemins absolus venant du fichier Compose. */
function insideDir(dir: string, path: string): string {
  const root = resolve(dir)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new DeployError(`Chemin hors du dossier de l'environnement : ${path}`)
  }
  return target
}

/**
 * Écrit un fichier neuf, lisible par Vercio seul : l'ancien est supprimé d'abord, et `wx`
 * refuse de suivre un lien symbolique posé à sa place par un conteneur.
 */
async function writeFresh(path: string, content: string, mode = 0o600): Promise<void> {
  await rm(path, { force: true })
  await writeFile(path, content, { mode, flag: 'wx' })
}
