import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql as rawSql } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { ensureLocalHost } from '../src/bootstrap.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, runMigrations, type Database } from '../src/db/client.js'
import type { CommandRunner } from '../src/deploy/command.js'
import { EventEmitter } from 'node:events'
import type {
  ComposeContainer,
  ContainerDetails,
  ContainerState,
  DetachedRun,
  DockerEvent,
  EventOptions,
  ExecOptions,
  ExecSession,
  HostDriver,
  LogLine,
  LogOptions,
  SelfContainer,
  StatsOptions,
} from '../src/docker/host-driver.js'
import {
  CLEANUP_TARGETS,
  NOTIFICATION_GROUP_KEYS,
  type CleanupPreview,
  type CleanupTarget,
  type HostContainerView,
  type ContainerAction,
  type ContainerStatsSample,
  type ContainerView,
  type NotificationGroup,
} from '@vercio/shared'
import { notificationChannels, notificationDeliveries } from '../src/db/schema.js'
import { SecretBox } from '../src/lib/crypto.js'
import type { NotificationMessage } from '../src/notifications/message.js'
import { currentTimeStep, totpCode } from '../src/lib/totp.js'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
export const ORIGIN = 'https://vercio.example.com'
export const ADMIN_PASSWORD = 'motdepasse-test'

export type FakeContainer = Omit<
  ContainerView,
  'published' | 'networks' | 'dependsOn' | 'relayFor'
> &
  Partial<Pick<ContainerView, 'published' | 'networks' | 'dependsOn' | 'relayFor'>>

const completeContainer = (container: FakeContainer): ContainerView => ({
  published: [],
  networks: [],
  dependsOn: [],
  relayFor: null,
  ...structuredClone(container),
})

/** Docker simulé pour l'API : conteneurs par projet Compose, actions enregistrées, logs fixes. */
export class FakeHost implements HostDriver {
  /** Champs réseau facultatifs dans les tests : complétés à la lecture. */
  containers = new Map<string, FakeContainer[]>()
  actions: { id: string; action: ContainerAction }[] = []
  logs = new Map<string, LogLine[]>()

  ping = async () => true
  info = async () => ({
    serverVersion: '29.0.0',
    operatingSystem: 'Test OS',
    architecture: 'x86_64',
    cpus: 4,
    memoryBytes: 8 * 1024 ** 3,
    containers: { total: 3, running: 2, paused: 0, stopped: 1 },
    images: 5,
  })

  async listContainers(composeProject: string): Promise<ContainerView[]> {
    return (this.containers.get(composeProject) ?? []).map(completeContainer)
  }

  async composeContainerViews(): Promise<Map<string, ContainerView[]>> {
    return new Map(
      [...this.containers].map(([project, list]) => [project, list.map(completeContainer)]),
    )
  }

  async containerAction(id: string, action: ContainerAction) {
    this.actions.push({ id, action })
    for (const list of this.containers.values()) {
      for (const container of list) {
        if (container.id === id) container.state = action === 'stop' ? 'exited' : 'running'
      }
    }
  }

  /** Conteneurs vus par les alertes (inspect, réconciliation). */
  states = new Map<string, ContainerState>()
  readonly #events = new EventEmitter()

  /** Émet un évènement Docker vers les observateurs. */
  emitEvent(event: Omit<DockerEvent, 'time' | 'timeNano'> & { time?: number }) {
    const now = Date.now()
    this.#events.emit('event', {
      time: Math.floor(now / 1000),
      timeNano: `${now}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      ...event,
    } satisfies DockerEvent)
  }

  /** Nombre d'observateurs branchés sur le flux d'évènements. */
  get watching(): number {
    return this.#events.listenerCount('event')
  }

  async watchEvents(options: EventOptions) {
    this.#events.on('event', options.onEvent)
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => {
        this.#events.off('event', options.onEvent)
        resolve()
      }),
    )
  }

  async composeContainers() {
    return [...this.states.values()].map((state) => ({ ...state }))
  }

  /** Page Conteneurs : tous les conteneurs de l'hôte. */
  hostList: HostContainerView[] = []
  /** Nettoyages demandés, et espace « récupéré » par type. */
  cleanups: CleanupTarget[] = []
  reclaimable: Partial<Record<CleanupTarget, { count: number; bytes: number }>> = {}

  async hostContainers() {
    return structuredClone(this.hostList)
  }

  async cleanupPreview() {
    const empty = { count: 0, bytes: 0 }
    return {
      targets: Object.fromEntries(
        CLEANUP_TARGETS.map((target) => [target, this.reclaimable[target] ?? empty]),
      ) as CleanupPreview['targets'],
      measuredAt: new Date().toISOString(),
    }
  }

  async cleanup(target: CleanupTarget) {
    if (target === 'build-cache' && this.reclaimable['build-cache']?.count === -1) {
      throw new Error('builder indisponible')
    }
    this.cleanups.push(target)
    const freed = this.reclaimable[target] ?? { count: 0, bytes: 0 }
    return { deleted: freed.count, bytes: freed.bytes }
  }

  /** Conteneurs Compose de l'hôte, pour l'import de projets. */
  inventory: ComposeContainer[] = []

  async composeInventory() {
    return structuredClone(this.inventory)
  }

  async inspectContainer(id: string) {
    const state = this.states.get(id)
    return state ? { ...state } : null
  }

  async streamLogs(id: string, options: LogOptions) {
    for (const line of (this.logs.get(id) ?? []).slice(-options.tail || undefined)) {
      options.onLine(line)
    }
  }

  /** Mesures émises à l'ouverture du flux de statistiques d'un conteneur. */
  stats = new Map<string, ContainerStatsSample[]>()
  /** Flux de statistiques ouverts, par conteneur. */
  statsStreams = new Map<string, number>()

  async streamStats(id: string, options: StatsOptions) {
    this.statsStreams.set(id, (this.statsStreams.get(id) ?? 0) + 1)
    for (const sample of this.stats.get(id) ?? []) options.onSample(sample)
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve()
      options.signal.addEventListener('abort', () => resolve())
    })
    this.statsStreams.set(id, (this.statsStreams.get(id) ?? 1) - 1)
  }

  details = new Map<string, ContainerDetails>()

  async containerDetails(id: string) {
    const details = this.details.get(id)
    return details ? structuredClone(details) : null
  }

  /** Réseaux Docker existants → conteneurs attachés. */
  dockerNetworks = new Map<string, { name: string; project: string | null }[]>()

  async networks(names: string[]) {
    return new Map(
      names
        .filter((name) => this.dockerNetworks.has(name))
        .map((name) => [name, { containers: structuredClone(this.dockerNetworks.get(name)!) }]),
    )
  }

  /** Conteneur de Vercio (mise à jour) ; null : hors conteneur. */
  self: SelfContainer | null = null
  async selfContainer() {
    return this.self ? structuredClone(this.self) : null
  }

  /** Conteneurs lancés à part (mise à jour de Vercio). */
  detached: DetachedRun[] = []
  async runDetached(options: DetachedRun) {
    this.detached.push(structuredClone(options))
    return `detache-${this.detached.length}`
  }

  /** Branchements en direct : réseau → conteneurs et alias. */
  connected: { network: string; id: string; aliases: string[] }[] = []

  async connectNetwork(name: string, containers: { id: string; aliases: string[] }[]) {
    if (!this.dockerNetworks.has(name)) this.dockerNetworks.set(name, [])
    for (const container of containers) this.connected.push({ network: name, ...container })
  }

  async removeNetwork(name: string) {
    const containers = this.dockerNetworks.get(name)
    if (!containers) return 'missing' as const
    if (containers.length) return 'in_use' as const
    this.dockerNetworks.delete(name)
    return 'removed' as const
  }

  /** Shells ouverts : le faux shell renvoie la saisie et se termine sur « exit ». */
  execs: (ExecOptions & { id: string; input: string; resized: number[][]; closed: boolean })[] = []

  async exec(id: string, options: ExecOptions): Promise<ExecSession> {
    const record = { id, ...options, input: '', resized: [] as number[][], closed: false }
    this.execs.push(record)
    const output = new EventEmitter()
    let finish: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>((resolve) => (finish = resolve))
    return {
      write: (data) => {
        record.input += String(data)
        output.emit('data', Buffer.from(`echo:${String(data)}`))
        if (String(data).includes('exit')) setTimeout(() => finish(3), 5)
      },
      resize: async (cols, rows) => {
        record.resized.push([cols, rows])
      },
      onData: (listener) => output.on('data', listener),
      pause: () => {},
      resume: () => {},
      exited,
      close: () => {
        record.closed = true
        finish(null)
      },
    }
  }
}

export const fakeHost = new FakeHost()

/**
 * Application complète sur une base PostgreSQL jetable : le schéma est entièrement recréé.
 */
export async function setupTestApp(
  env: Record<string, string> = {},
  runner?: CommandRunner,
  host: HostDriver = fakeHost,
  update?: Parameters<typeof buildApp>[0]['update'],
) {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL requis')
  const config = loadConfig({
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: TEST_DATABASE_URL,
    VERCIO_SECRET_KEY: 'x'.repeat(32),
    VERCIO_ADMIN_PASSWORD: ADMIN_PASSWORD,
    VERCIO_DATA_DIR: join(tmpdir(), `vercio-test-${process.pid}`),
    ...env,
  })
  const database = createDatabase(config.DATABASE_URL)
  const db: Database = database.db
  await db.execute(
    rawSql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public`,
  )
  await runMigrations(db, new URL('../drizzle', import.meta.url).pathname)
  await ensureLocalHost(db)
  // Restaurations de Vercio : comptées au lieu d'arrêter le processus de test.
  const restarts = { count: 0 }
  // File relevée à la main (`drain`) ; récepteurs de test sur 127.0.0.1.
  const app: FastifyInstance = await buildApp({
    config,
    db,
    host,
    runner,
    notificationOptions: { allowLoopback: true, manual: true },
    restart: () => {
      restarts.count++
    },
    update,
  })
  return {
    app,
    db,
    restarts,
    close: async () => {
      await app.close()
      await database.sql.end()
    },
  }
}

export function cookieValue(response: LightMyRequestResponse, name: string): string {
  const cookie = response.cookies.find((c) => c.name === name)
  if (!cookie) throw new Error(`cookie ${name} absent`)
  return `${name}=${cookie.value}`
}

/**
 * Horloge contrôlée pour le TOTP : chaque connexion avance de 30 s,
 * sinon le même code serait refusé (anti-rejeu).
 */
export function controlledClock() {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return {
    tick: (ms = 30_000) => {
      now += ms
    },
    step: () => currentTimeStep(now),
  }
}

export { totpCode }

/** Canal webhook abonné aux évènements donnés ; la file n'est pas relevée (rien n'est envoyé). */
export async function addWatchChannel(
  db: Database,
  groups: NotificationGroup[] = NOTIFICATION_GROUP_KEYS,
) {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      name: `Observateur ${groups.join(',')}`,
      type: 'webhook',
      configEnc: new SecretBox('x'.repeat(32)).encrypt(
        JSON.stringify({ url: 'https://hooks.example.com/vercio', secret: 'whsec_AAAA' }),
      ),
      groups,
    })
    .returning()
  return row!
}

/** Messages en file, du plus ancien au plus récent. */
export async function queuedNotifications(db: Database) {
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .orderBy(notificationDeliveries.createdAt)
  return rows.map((row) => ({
    ...(row.message as NotificationMessage),
    suppressedCount: row.suppressedCount,
  }))
}
