import { and, desc, eq, gte, isNull, like } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { composeProjectName, type NotificationEvent } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSettings, environments, notificationIncidents, projects } from '../db/schema.js'
import type { ContainerState, DockerEvent, HostDriver } from '../docker/host-driver.js'
import { buildMessage } from './message.js'
import type { NotificationService } from './service.js'

type IncidentKind = 'down' | 'restarting' | 'unhealthy'
type IncidentRow = typeof notificationIncidents.$inferSelect

interface Target {
  id: string
  slug: string
  name: string
  project: { id: string; slug: string; name: string }
}

export const CONTAINER_DELAYS = {
  /** Après un arrêt involontaire : le conteneur a-t-il été relancé par sa politique ? */
  confirmDown: 30_000,
  /** Service arrêté rétabli : 60 s en marche. */
  stableRunning: 60_000,
  /** Service unhealthy rétabli : 2 min healthy. */
  stableHealthy: 120_000,
  /** Boucle de redémarrage terminée : 10 min sans arrêt. */
  stableLoop: 600_000,
  /** Silence pendant un déploiement de l'environnement et 2 min après. */
  deployGrace: 120_000,
  /** Un `kill` reçu dans les 5 min avant l'arrêt : arrêt volontaire (stop, restart, down). */
  killWindow: 300_000,
  /** Fenêtre de comptage des arrêts pour la boucle de redémarrage. */
  loopWindow: 600_000,
  /** Incident revenu moins de 30 min après sa résolution : service instable. */
  flapWindow: 1_800_000,
  reconcile: 300_000,
  reconnectMin: 5_000,
  reconnectMax: 60_000,
}
/** Arrêts en 10 min à partir desquels un service « redémarre en boucle ». */
const LOOP_CRASHES = 3
/** Signaux d'un arrêt demandé : SIGINT, SIGQUIT, SIGKILL, SIGTERM. */
const VOLUNTARY_SIGNALS = new Set(['2', '3', '9', '15', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM'])
const CURSOR_KEY = 'docker_events_cursor'

const KIND_EVENTS: Record<IncidentKind, NotificationEvent> = {
  down: 'container.down',
  restarting: 'container.restarting',
  unhealthy: 'container.unhealthy',
}

export interface ContainerWatcherOptions {
  db: Database
  host: HostDriver
  engine: { isDeploying(environmentId: string, graceMs?: number): boolean }
  notifications: NotificationService
  log: FastifyBaseLogger
  delays?: Partial<typeof CONTAINER_DELAYS>
}

/** Code de sortie expliqué : « 137 : tué (manque de mémoire ?) ». */
export function describeExit(state: Pick<ContainerState, 'exitCode' | 'oomKilled'>): string {
  if (state.oomKilled) return 'arrêté par manque de mémoire (OOM)'
  switch (state.exitCode) {
    case null:
      return 'arrêté'
    case 137:
      return 'tué (code 137 : SIGKILL, souvent un manque de mémoire)'
    case 143:
      return 'arrêté par SIGTERM (code 143)'
    case 139:
      return 'plantage (code 139 : erreur de segmentation)'
    default:
      return `l’application s’est arrêtée avec le code ${state.exitCode}`
  }
}

/** Arrêt qui ressemble à une panne, vu après coup (réconciliation). */
function involuntaryExit(state: ContainerState): boolean {
  if (state.oomKilled) return true
  return state.exitCode !== null && ![0, 130, 137, 143].includes(state.exitCode)
}

/**
 * Alertes conteneur : un service arrêté de façon inattendue, qui redémarre en boucle ou
 * unhealthy ouvre un incident (notifié une fois), fermé après une période de stabilité
 * (rétablissement notifié). Les arrêts volontaires, les conteneurs ponctuels et les
 * environnements en cours de déploiement ne déclenchent rien.
 */
export class ContainerWatcher {
  readonly #delays: typeof CONTAINER_DELAYS
  readonly #targets = new Map<string, Target>()
  /** Projets Compose inconnus de Vercio, et dernière vérification (rechargement au plus 1×/30 s). */
  readonly #unknown = new Map<string, number>()
  readonly #kills = new Map<string, number>()
  readonly #crashes = new Map<string, number[]>()
  readonly #seen = new Set<string>()
  readonly #pending = new Set<Promise<void>>()
  #chain: Promise<void> = Promise.resolve()
  #abort: AbortController | null = null
  #reconcileTimer: NodeJS.Timeout | null = null
  #loop: Promise<void> | null = null
  #stopped = false
  /** Réveille la boucle en attente de reconnexion (arrêt immédiat). */
  #wake: (() => void) | null = null
  /** Dernier évènement traité (secondes Unix), sauvegardé au plus toutes les 10 s. */
  #cursor = 0
  #cursorSavedAt = 0
  /** Arrêts antérieurs ignorés à la réconciliation (premier démarrage). */
  #watchingSince = Math.floor(Date.now() / 1000)

  constructor(private readonly options: ContainerWatcherOptions) {
    this.#delays = { ...CONTAINER_DELAYS, ...options.delays }
  }

  start(): void {
    if (this.#loop) return
    this.#stopped = false
    this.#loop = this.run()
    this.#reconcileTimer = setInterval(
      () => this.enqueue(() => this.reconcile()),
      this.#delays.reconcile,
    )
    this.#reconcileTimer.unref()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer)
    this.#abort?.abort()
    this.#wake?.()
    await this.#loop
    this.#loop = null
  }

  /** Attend le traitement des évènements reçus et des vérifications planifiées (tests). */
  async idle(): Promise<void> {
    while (true) {
      await this.#chain
      if (this.#pending.size === 0) return
      await Promise.all(this.#pending)
    }
  }

  private async run(): Promise<void> {
    let delay = this.#delays.reconnectMin
    while (!this.#stopped) {
      try {
        const since = await this.readCursor()
        await this.loadTargets()
        await this.reconcile()
        this.#abort = new AbortController()
        const watching = this.options.host.watchEvents({
          since,
          signal: this.#abort.signal,
          onEvent: (event) => this.enqueue(() => this.handle(event)),
        })
        delay = this.#delays.reconnectMin
        await watching
      } catch (error) {
        this.options.log.debug({ err: error }, 'Évènements Docker indisponibles')
      }
      if (this.#stopped) break
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        timer.unref()
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.#wake = null
      delay = Math.min(delay * 2, this.#delays.reconnectMax)
    }
  }

  /** Traitement dans l'ordre d'arrivée ; la lecture du flux n'attend jamais. */
  private enqueue(task: () => Promise<void>): void {
    this.#chain = this.#chain.then(task).catch((error: unknown) => {
      this.options.log.warn({ err: error }, 'Alerte conteneur non traitée')
    })
  }

  private later(ms: number, task: () => Promise<void>): void {
    const done = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.enqueue(task)
        void this.#chain.then(resolve)
      }, ms).unref()
    })
    this.#pending.add(done)
    void done.then(() => this.#pending.delete(done))
  }

  // --- Environnements suivis --------------------------------------------------------------

  /** Projet Compose → environnement (format Vercio en v1 ; projets importés en v0.2). */
  private async loadTargets(): Promise<void> {
    const rows = await this.options.db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
    this.#targets.clear()
    this.#unknown.clear()
    for (const { environment, project } of rows) {
      this.#targets.set(composeProjectName(project.slug, environment.slug), {
        id: environment.id,
        slug: environment.slug,
        name: environment.name,
        project: { id: project.id, slug: project.slug, name: project.name },
      })
    }
  }

  private async target(composeProject: string): Promise<Target | null> {
    const known = this.#targets.get(composeProject)
    if (known) return known
    // Projet inconnu : peut-être un environnement créé depuis le dernier chargement.
    const checked = this.#unknown.get(composeProject)
    if (checked !== undefined && Date.now() - checked < 30_000) return null
    await this.loadTargets()
    const target = this.#targets.get(composeProject) ?? null
    if (!target) this.#unknown.set(composeProject, Date.now())
    return target
  }

  // --- Évènements -------------------------------------------------------------------------

  private async handle(event: DockerEvent): Promise<void> {
    const attributes = event.attributes
    const project = attributes['com.docker.compose.project']
    if (!project) return
    const id = `${event.id}|${event.action}|${event.timeNano}`
    if (this.#seen.has(id)) return
    this.#seen.add(id)
    if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!)
    this.advanceCursor(event.time)
    if (attributes['com.docker.compose.oneoff'] === 'True') return
    const target = await this.target(project)
    if (!target) return
    const key = `container:${project}/${attributes['com.docker.compose.service'] ?? ''}/${attributes['com.docker.compose.container-number'] ?? '1'}`
    const quiet = this.options.engine.isDeploying(target.id, this.#delays.deployGrace)
    const now = Date.now()

    if (event.action === 'kill') {
      if (VOLUNTARY_SIGNALS.has(attributes.signal ?? '')) this.#kills.set(event.id, now)
      return
    }
    if (event.action === 'die') {
      const killed = this.#kills.get(event.id)
      this.#kills.delete(event.id)
      if (killed !== undefined && now - killed < this.#delays.killWindow) return
      if (quiet) {
        // Pendant un déploiement et juste après : vérifié une fois la période passée (une version
        // qui plante une minute après sa mise en ligne doit être signalée).
        this.#crashes.delete(key)
        this.later(this.#delays.deployGrace + this.#delays.confirmDown, () =>
          this.confirmDown(target, key, event.id),
        )
        return
      }
      const crashes = (this.#crashes.get(key) ?? []).filter(
        (at) => now - at < this.#delays.loopWindow,
      )
      crashes.push(now)
      this.#crashes.set(key, crashes)
      this.later(this.#delays.confirmDown, () => this.confirmDown(target, key, event.id))
      return
    }
    if (event.action === 'start') {
      if (!quiet) {
        this.later(this.#delays.stableRunning, () => this.confirmRunning(target, key, event.id))
      }
      return
    }
    if (event.action === 'destroy') {
      // Conteneur supprimé (recréation, down) : ses incidents se ferment sans message.
      for (const kind of ['down', 'restarting', 'unhealthy'] as const) {
        await this.resolve(target, key, kind, null, { silent: true })
      }
      this.#crashes.delete(key)
      return
    }
    if (event.action.startsWith('health_status')) {
      const status = event.action.split(':')[1]?.trim()
      if (status === 'unhealthy' && !quiet) {
        const state = await this.options.host.inspectContainer(event.id)
        if (state?.running && state.health === 'unhealthy') {
          await this.open(target, key, 'unhealthy', state)
        }
      } else if (status === 'healthy') {
        this.later(this.#delays.stableHealthy, () => this.confirmHealthy(target, key, event.id))
      }
    }
  }

  private async confirmDown(target: Target, key: string, containerId: string): Promise<void> {
    if (this.options.engine.isDeploying(target.id, this.#delays.deployGrace)) return
    const state = await this.options.host.inspectContainer(containerId)
    if (!state) return
    if (state.running || state.restarting) {
      // Relancé par sa politique de redémarrage : seule une boucle est signalée.
      const crashes = this.recentCrashes(key)
      if (crashes >= LOOP_CRASHES) {
        await this.open(target, key, 'restarting', state, { crashes })
      }
      this.later(this.#delays.stableLoop, () => this.confirmLoopOver(target, key, containerId))
      return
    }
    await this.open(target, key, 'down', state)
  }

  private async confirmRunning(target: Target, key: string, containerId: string) {
    const state = await this.options.host.inspectContainer(containerId)
    if (state?.running && !state.restarting) await this.resolve(target, key, 'down', state)
  }

  private async confirmHealthy(target: Target, key: string, containerId: string) {
    const state = await this.options.host.inspectContainer(containerId)
    if (state?.running && state.health === 'healthy') {
      await this.resolve(target, key, 'unhealthy', state)
    }
  }

  private async confirmLoopOver(target: Target, key: string, containerId: string) {
    if (this.recentCrashes(key, this.#delays.stableLoop) > 0) return
    const state = await this.options.host.inspectContainer(containerId)
    if (state?.running && !state.restarting) await this.resolve(target, key, 'restarting', state)
  }

  private recentCrashes(key: string, windowMs = this.#delays.loopWindow): number {
    const now = Date.now()
    // Marge de 50 ms : la vérification planifiée tombe pile à la fin de la fenêtre.
    return (this.#crashes.get(key) ?? []).filter((at) => now - at < windowMs - 50).length
  }

  /**
   * Rattrapage (connexion au démon, puis toutes les 5 min) : les évènements manqués pendant un
   * arrêt de Vercio ou une coupure du flux sont déduits de l'état des conteneurs.
   */
  async reconcile(): Promise<void> {
    await this.loadTargets()
    const states = await this.options.host.composeContainers()
    const present = new Set<string>()
    const grace = this.#delays.deployGrace
    for (const state of states) {
      if (state.oneoff) continue
      const target = this.#targets.get(state.project)
      if (!target) continue
      const key = `container:${state.project}/${state.service}/${state.number}`
      present.add(key)
      if (this.options.engine.isDeploying(target.id, grace)) continue
      if (state.running && !state.restarting) {
        await this.resolve(target, key, 'down', state)
        if (this.recentCrashes(key) === 0) await this.resolve(target, key, 'restarting', state)
        if (state.health !== 'unhealthy') await this.resolve(target, key, 'unhealthy', state)
        else await this.open(target, key, 'unhealthy', state)
      } else if (state.restarting) {
        await this.open(target, key, 'restarting', state, { crashes: state.restartCount })
      } else if (
        involuntaryExit(state) &&
        state.finishedAt &&
        Date.parse(state.finishedAt) / 1000 >= (this.#cursor || this.#watchingSince)
      ) {
        await this.open(target, key, 'down', state)
      }
    }
    // Conteneurs disparus : incidents fermés sans message.
    const open = await this.options.db
      .select()
      .from(notificationIncidents)
      .where(
        and(
          isNull(notificationIncidents.resolvedAt),
          like(notificationIncidents.key, 'container:%'),
        ),
      )
    for (const incident of open) {
      if (present.has(incident.key)) continue
      const project = incident.key.slice('container:'.length).split('/')[0] ?? ''
      const target = this.#targets.get(project)
      if (!target) continue
      await this.resolve(target, incident.key, incident.kind as IncidentKind, null, {
        silent: true,
      })
    }
  }

  // --- Incidents --------------------------------------------------------------------------

  private async open(
    target: Target,
    key: string,
    kind: IncidentKind,
    state: ContainerState,
    extra: { crashes?: number } = {},
  ): Promise<void> {
    const db = this.options.db
    const data = { ...snapshot(state), ...extra }
    const [recent] = await db
      .select()
      .from(notificationIncidents)
      .where(
        and(
          eq(notificationIncidents.key, key),
          eq(notificationIncidents.kind, kind),
          gte(notificationIncidents.resolvedAt, new Date(Date.now() - this.#delays.flapWindow)),
        ),
      )
      .orderBy(desc(notificationIncidents.resolvedAt))
      .limit(1)

    let incident: IncidentRow | undefined
    let flapping = false
    if (recent) {
      // Revenu peu après sa résolution : l'incident est rouvert ; seul le premier retour est
      // signalé (« instable »), les suivants restent silencieux jusqu'à la stabilité.
      try {
        ;[incident] = await db
          .update(notificationIncidents)
          .set({
            resolvedAt: null,
            occurrences: recent.occurrences + 1,
            notified: recent.occurrences + 1 === 2,
            data,
          })
          .where(and(eq(notificationIncidents.id, recent.id)))
          .returning()
      } catch {
        return // déjà ouvert (index unique des incidents ouverts)
      }
      flapping = true
    } else {
      ;[incident] = await db
        .insert(notificationIncidents)
        .values({ key, kind, environmentId: target.id, data, notified: true })
        .onConflictDoNothing()
        .returning()
    }
    if (!incident?.notified) return
    await this.options.notifications.notify(
      this.message(target, kind, 'open', state, incident, { ...extra, flapping }),
      { groupKey: `env:${target.id}` },
    )
  }

  private async resolve(
    target: Target,
    key: string,
    kind: IncidentKind,
    state: ContainerState | null,
    { silent = false } = {},
  ): Promise<void> {
    const [incident] = await this.options.db
      .update(notificationIncidents)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(notificationIncidents.key, key),
          eq(notificationIncidents.kind, kind),
          isNull(notificationIncidents.resolvedAt),
        ),
      )
      .returning()
    if (!incident || silent || !incident.notified || !state) return
    await this.options.notifications.notify(
      this.message(target, kind, 'resolved', state, incident),
      { groupKey: `env:${target.id}` },
    )
  }

  private message(
    target: Target,
    kind: IncidentKind,
    status: 'open' | 'resolved',
    state: ContainerState,
    incident: IncidentRow,
    extra: { crashes?: number; flapping?: boolean } = {},
  ) {
    const where = `${state.service} · ${target.project.name} / ${target.name}`
    let event: NotificationEvent = KIND_EVENTS[kind]
    let severity: 'critical' | 'warning' | 'success' = kind === 'unhealthy' ? 'warning' : 'critical'
    let title: string
    let summary: string
    if (status === 'resolved') {
      event = 'container.recovered'
      severity = 'success'
      const minutes = Math.max(1, Math.round((Date.now() - incident.openedAt.getTime()) / 60_000))
      title = `Service rétabli · ${where}`
      summary =
        kind === 'unhealthy'
          ? `Le healthcheck répond de nouveau (incident de ${minutes} min).`
          : `Le service tourne de nouveau normalement (incident de ${minutes} min).`
    } else if (kind === 'down') {
      title = `${extra.flapping ? 'Service instable, de nouveau arrêté' : 'Service arrêté'} · ${where}`
      summary = `Le conteneur s’est arrêté de façon inattendue : ${describeExit(state)}.${
        state.restartPolicy === 'no'
          ? ' Il ne redémarrera pas seul (pas de politique de redémarrage).'
          : ''
      }`
    } else if (kind === 'restarting') {
      title = `Service qui redémarre en boucle · ${where}`
      summary = `${extra.crashes ?? state.restartCount} arrêts en peu de temps : ${describeExit(state)}.`
    } else {
      title = `${extra.flapping ? 'Service instable, de nouveau unhealthy' : 'Service unhealthy'} · ${where}`
      summary = 'Le healthcheck du service échoue.'
    }
    return buildMessage({
      event,
      severity,
      title,
      summary,
      facts: [
        { label: 'Service', value: state.service },
        { label: 'Conteneur', value: state.name },
        {
          label: 'Code de sortie',
          value: status === 'open' && state.exitCode !== null ? String(state.exitCode) : '',
        },
        { label: 'Redémarrages', value: state.restartCount ? String(state.restartCount) : '' },
      ],
      url: this.options.notifications.link(
        `/projets/${target.project.slug}?onglet=logs&env=${target.slug}`,
      ),
      linkLabel: 'Voir les logs',
      project: target.project,
      environment: { id: target.id, slug: target.slug, name: target.name },
      incident: { id: incident.id, status },
      data: { kind, ...snapshot(state), ...(extra.crashes ? { crashes: extra.crashes } : {}) },
    })
  }

  // --- Curseur ----------------------------------------------------------------------------

  private async readCursor(): Promise<number | undefined> {
    const [row] = await this.options.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, CURSOR_KEY))
      .limit(1)
    const time = (row?.value as { time?: number } | undefined)?.time
    // Le démon ne garde que ses derniers évènements en mémoire : au-delà d'1 h, rien à relire.
    if (!time || Date.now() / 1000 - time > 3600) return undefined
    this.#cursor = Math.max(this.#cursor, time)
    return time
  }

  private advanceCursor(time: number): void {
    if (time <= this.#cursor) return
    this.#cursor = time
    if (Date.now() - this.#cursorSavedAt < 10_000) return
    this.#cursorSavedAt = Date.now()
    const value = { time }
    void this.options.db
      .insert(appSettings)
      .values({ key: CURSOR_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
      .catch(() => {})
  }
}

/** Champs repris dans le message et le webhook sortant : aucune variable ni label du conteneur. */
function snapshot(state: ContainerState) {
  return {
    service: state.service,
    containerName: state.name,
    containerNumber: state.number,
    exitCode: state.exitCode,
    oomKilled: state.oomKilled,
    restartCount: state.restartCount,
    health: state.health,
  }
}
