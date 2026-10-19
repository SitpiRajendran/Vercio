import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { timingSafeEqual, type Hmac } from 'node:crypto'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  composeProjectName,
  isBackupItemIncluded,
  s3CredentialsSchema,
  type BackupCandidate,
  type BackupItem,
  type BackupSchedule,
  type BackupStatus,
  type BackupTrigger,
  type ContainerView,
  type DatabaseEngine,
  type LocalDestinationConfig,
  type S3DestinationConfig,
  type VercioRestoreState,
} from '@vercio/shared'
import type { CommandRunner } from '../deploy/command.js'
import type { Database } from '../db/client.js'
import {
  appSettings,
  backupDestinations,
  deployments,
  users,
  backupPlans,
  backupRestores,
  backups,
  environments,
  projects,
} from '../db/schema.js'
import type { HostDriver } from '../docker/host-driver.js'
import { audit } from '../lib/audit.js'
import type { SecretBox } from '../lib/crypto.js'
import { buildMessage } from '../notifications/message.js'
import type { NotificationService } from '../notifications/service.js'
import { decryptStream, encryptStream } from './crypto.js'
import { databaseEngine, DUMP_EXTENSION, dumpScript, restoreScript } from './databases.js'
import { LocalStore, S3Store, type BackupStore } from './store.js'

/** Image des copies de volumes (tar) : récupérée une fois, puis réutilisée. */
export const BACKUP_HELPER_IMAGE = 'alpine:3.20'
const MANIFEST = 'manifest.json'
/** Sauvegardes en échec gardées dans l'historique (les réussies suivent la rétention). */
const FAILED_KEPT = 10

type DestinationRow = typeof backupDestinations.$inferSelect
type User = { id: string; username: string } | null

export interface BackupServiceOptions {
  db: Database
  box: SecretBox
  host: HostDriver
  runner: CommandRunner
  dataDir: string
  dockerSocket: string
  notifications: NotificationService
  log: FastifyBaseLogger
  /** Base de Vercio : exportée par `pg_dump` dans un conteneur auxiliaire. */
  databaseUrl: string
  /** Après la restauration de Vercio : arrêt propre, Docker relance le conteneur. */
  restart: () => void
  now?: () => Date
}

/** Réglage de la sauvegarde de Vercio (`app_settings`). */
export const VERCIO_BACKUP_KEY = 'vercio_backup'
export const VERCIO_LOCATION = '_vercio'
const VERCIO_ITEM = 'database:vercio'

export interface VercioBackupPlan {
  enabled: boolean
  destinationId: string
  schedule: BackupSchedule
  keep: number
  nextRunAt: string | null
}

/** Sauvegardes d'un environnement, ou de Vercio (null). */
const sameScope = (environmentId: string | null) =>
  environmentId ? eq(backups.environmentId, environmentId) : isNull(backups.environmentId)

/** Prochaine exécution : heure fixe chaque jour (heure du serveur) ou toutes les N heures. */
export function nextRun(schedule: BackupSchedule, from: Date): Date {
  if (schedule.kind === 'interval') return new Date(from.getTime() + schedule.hours * 3_600_000)
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number]
  const next = new Date(from)
  next.setHours(hours, minutes, 0, 0)
  if (next <= from) next.setDate(next.getDate() + 1)
  return next
}

export function createStore(row: DestinationRow, box: SecretBox): BackupStore {
  if (row.type === 'local') return new LocalStore(row.config as LocalDestinationConfig)
  const credentials = s3CredentialsSchema.parse(JSON.parse(box.decrypt(row.credentialsEnc!)))
  return new S3Store(row.config as S3DestinationConfig, credentials)
}

/** Erreur lisible renvoyée par une étape, sans pile. */
class StepError extends Error {}

/**
 * Sauvegardes des environnements : volumes nommés (archive tar) et bases de données (export
 * logique), envoyés vers un dossier du serveur ou un stockage S3, chiffrés si une phrase est
 * définie. Une seule opération (sauvegarde ou restauration) à la fois.
 */
export class BackupService {
  #queue: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | null = null
  #ticking = false
  #vercioRestore: VercioRestoreState | null = null
  readonly #staging: string
  readonly #now: () => Date

  constructor(private readonly options: BackupServiceOptions) {
    this.#staging = join(resolve(options.dataDir), 'backups-tmp')
    this.#now = options.now ?? (() => new Date())
  }

  store(row: DestinationRow): BackupStore {
    return createStore(row, this.options.box)
  }

  passphrase(row: Pick<DestinationRow, 'passphraseEnc'>): string | null {
    return row.passphraseEnc ? this.options.box.decrypt(row.passphraseEnc) : null
  }

  /** Démarrage : les opérations interrompues par un arrêt de Vercio sont closes en échec. */
  async recover(): Promise<void> {
    const { db } = this.options
    const error = 'Interrompue par un redémarrage de Vercio'
    await db
      .update(backups)
      .set({ status: 'failed', error, finishedAt: this.#now() })
      .where(eq(backups.status, 'running'))
    await db
      .update(backupRestores)
      .set({ status: 'failed', error, finishedAt: this.#now() })
      .where(eq(backupRestores.status, 'running'))
    await rm(this.#staging, { recursive: true, force: true })
  }

  start(): void {
    this.#timer = setInterval(() => void this.tick(), 60_000)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Attend la fin des opérations en cours (tests, arrêt). */
  idle(): Promise<void> {
    return this.#queue
  }

  /** Lance les sauvegardes planifiées arrivées à échéance. */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const due = await this.options.db
        .select()
        .from(backupPlans)
        .where(and(eq(backupPlans.enabled, true), lte(backupPlans.nextRunAt, this.#now())))
      const vercio = await this.vercioPlan()
      if (vercio?.enabled && vercio.nextRunAt && new Date(vercio.nextRunAt) <= this.#now()) {
        await this.saveVercioPlan({
          ...vercio,
          nextRunAt: nextRun(vercio.schedule, this.#now()).toISOString(),
        })
        await this.requestVercio('schedule', null).catch((error: unknown) =>
          this.options.log.error({ err: error }, 'Sauvegarde planifiée de Vercio impossible'),
        )
      }
      for (const plan of due) {
        // Échéance suivante fixée tout de suite : pas de doublon si la sauvegarde dure.
        await this.options.db
          .update(backupPlans)
          .set({ nextRunAt: nextRun(plan.schedule as BackupSchedule, this.#now()) })
          .where(eq(backupPlans.environmentId, plan.environmentId))
        await this.request(plan.environmentId, 'schedule', null).catch((error: unknown) =>
          this.options.log.error({ err: error }, 'Sauvegarde planifiée impossible'),
        )
      }
    } finally {
      this.#ticking = false
    }
  }

  // --- Ce qui peut être sauvegardé ------------------------------------------------------

  /** Volumes nommés montés par les conteneurs de l'environnement, et bases reconnues. */
  async candidates(projectSlug: string, environmentSlug: string): Promise<BackupCandidate[]> {
    const { host } = this.options
    const containers = await host.listContainers(composeProjectName(projectSlug, environmentSlug))
    const volumes = new Map<string, { services: Set<string>; databases: Set<string> }>()
    const databases = new Map<string, DatabaseEngine>()
    for (const container of containers) {
      if (container.relayFor) continue
      const engine = databaseEngine(container.image)
      if (engine && container.service) databases.set(container.service, engine)
      const details = await host.containerDetails(container.id)
      for (const mount of details?.mounts ?? []) {
        if (mount.type !== 'volume' || !mount.source) continue
        const entry = volumes.get(mount.source) ?? { services: new Set(), databases: new Set() }
        entry.services.add(container.service)
        if (engine) entry.databases.add(container.service)
        volumes.set(mount.source, entry)
      }
    }
    const items: BackupCandidate[] = [...databases].sort().map(([service, engine]) => ({
      key: `database:${service}`,
      kind: 'database',
      name: service,
      engine,
      services: [service],
      coveredBy: null,
      includedByDefault: true,
    }))
    for (const [name, entry] of [...volumes].sort(([a], [b]) => a.localeCompare(b))) {
      const coveredBy = [...entry.databases].sort()[0] ?? null
      items.push({
        key: `volume:${name}`,
        kind: 'volume',
        name,
        engine: null,
        services: [...entry.services].sort(),
        coveredBy,
        includedByDefault: coveredBy === null,
      })
    }
    return items
  }

  // --- Sauvegarde --------------------------------------------------------------------------

  /** Met une sauvegarde en file ; renvoie son identifiant. */
  async request(environmentId: string, trigger: BackupTrigger, user: User): Promise<string> {
    const { db } = this.options
    const [row] = await db
      .select({
        plan: backupPlans,
        destination: backupDestinations,
        env: environments,
        project: projects,
      })
      .from(backupPlans)
      .innerJoin(backupDestinations, eq(backupDestinations.id, backupPlans.destinationId))
      .innerJoin(environments, eq(environments.id, backupPlans.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(backupPlans.environmentId, environmentId))
    if (!row) throw new StepError('Configurez d’abord la sauvegarde de cet environnement')
    const [running] = await db
      .select({ id: backups.id })
      .from(backups)
      .where(and(eq(backups.environmentId, environmentId), eq(backups.status, 'running')))
      .limit(1)
    if (running) return running.id
    const started = this.#now()
    const stamp = started
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replaceAll(':', '-')
    const [created] = await db
      .insert(backups)
      .values({
        environmentId,
        destinationId: row.destination.id,
        status: 'running',
        trigger,
        location: '',
        encrypted: !!row.destination.passphraseEnc,
        userId: user?.id ?? null,
        username: user?.username ?? null,
        startedAt: started,
      })
      .returning({ id: backups.id })
    const id = created!.id
    const location = `${row.project.slug}/${row.env.slug}/${stamp}-${id.slice(0, 8)}`
    await db.update(backups).set({ location }).where(eq(backups.id, id))
    this.#enqueue(() => this.#backup(id))
    return id
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((error: unknown) => {
      this.options.log.error({ err: error }, 'Opération de sauvegarde en échec')
    })
  }

  #docker(
    args: string[],
    io: { stdout?: NodeJS.WritableStream; stdin?: Readable; env?: Record<string, string> } = {},
  ) {
    const errors: string[] = []
    return this.options.runner
      .run('docker', args, {
        cwd: this.options.dataDir,
        env: {
          PATH: process.env.PATH ?? '',
          DOCKER_HOST: `unix://${this.options.dockerSocket}`,
          ...io.env,
        },
        timeoutMs: 6 * 3_600_000,
        onLine: (line, stream) => {
          if (stream === 'stderr' || !io.stdout) errors.push(line.trim())
        },
        ...(io.stdout ? { stdout: io.stdout as never } : {}),
        ...(io.stdin ? { stdin: io.stdin } : {}),
      })
      .then(({ code }) => ({ code, errors: errors.filter(Boolean) }))
  }

  async #backup(id: string): Promise<void> {
    const { db } = this.options
    const [row] = await db
      .select({
        backup: backups,
        plan: backupPlans,
        destination: backupDestinations,
        env: environments,
        project: projects,
      })
      .from(backups)
      .leftJoin(environments, eq(environments.id, backups.environmentId))
      .leftJoin(projects, eq(projects.id, environments.projectId))
      .leftJoin(backupPlans, eq(backupPlans.environmentId, backups.environmentId))
      .leftJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
      .where(eq(backups.id, id))
    if (!row) return
    if (!row.env || !row.project) return this.#backupVercio(row.backup, row.destination)
    const scope = { env: row.env, project: row.project }
    const logs: string[] = []
    const log = async (line: string) => {
      logs.push(`${this.#now().toISOString()} ${line}`)
      await db.update(backups).set({ logs }).where(eq(backups.id, id))
    }
    const items: BackupItem[] = []
    const dir = join(this.#staging, id)
    let error: string | null = null
    try {
      if (!row.destination) throw new StepError('Destination supprimée')
      const store = this.store(row.destination)
      const passphrase = this.passphrase(row.destination)
      const selection = row.plan?.selection ?? {}
      const candidates = (await this.candidates(scope.project.slug, scope.env.slug)).filter(
        (item) => isBackupItemIncluded(item, selection),
      )
      if (!candidates.length) {
        throw new StepError(
          'Rien à sauvegarder : aucun volume ni base de données (environnement arrêté ou sans données ?)',
        )
      }
      await mkdir(dir, { recursive: true })
      await log(
        `Sauvegarde vers « ${row.destination.name} » (${store.location}), dossier ${row.backup.location}${passphrase ? ', chiffrée' : ''}`,
      )
      const containers = await this.options.host.listContainers(
        composeProjectName(scope.project.slug, scope.env.slug),
      )
      for (const candidate of candidates) {
        const item: BackupItem = {
          key: candidate.key,
          kind: candidate.kind,
          name: candidate.name,
          engine: candidate.engine,
          file: null,
          sizeBytes: 0,
          status: 'failed',
          error: null,
        }
        items.push(item)
        const label =
          candidate.kind === 'volume' ? `volume ${candidate.name}` : `base ${candidate.name}`
        const startedAt = Date.now()
        try {
          const file =
            candidate.kind === 'volume'
              ? `volumes/${candidate.name}.tar.gz`
              : `databases/${candidate.name}.${DUMP_EXTENSION[candidate.engine!]}`
          const staged = join(dir, file.replace('/', '__'))
          await log(`→ ${label}…`)
          if (candidate.kind === 'volume') await this.#dumpVolume(candidate.name, staged)
          else await this.#dumpDatabase(containers, candidate.name, candidate.engine!, staged)
          const target = `${row.backup.location}/${file}${passphrase ? '.enc' : ''}`
          Object.assign(item, await this.#upload(store, target, staged, passphrase))
          await rm(staged, { force: true })
          item.file = file + (passphrase ? '.enc' : '')
          item.status = 'ok'
          await log(
            `✓ ${label} : ${formatSize(item.sizeBytes)} en ${Math.round((Date.now() - startedAt) / 1000)} s`,
          )
        } catch (cause) {
          item.error = (cause as Error).message
          await log(`✗ ${label} : ${item.error}`)
        }
        await db.update(backups).set({ items }).where(eq(backups.id, id))
      }
      const manifest = {
        format: 1,
        vercio: 'sauvegarde',
        project: scope.project.slug,
        environment: scope.env.slug,
        createdAt: row.backup.startedAt.toISOString(),
        encrypted: !!passphrase,
        items,
      }
      await store.put(
        `${row.backup.location}/${MANIFEST}`,
        Readable.from([JSON.stringify(manifest, null, 2)]),
      )
    } catch (cause) {
      error = (cause as Error).message
      await log(`Échec : ${error}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    const ok = items.filter((item) => item.status === 'ok')
    const status: BackupStatus =
      error || !ok.length ? 'failed' : ok.length < items.length ? 'partial' : 'succeeded'
    if (!error && status === 'failed') error = 'Aucun élément sauvegardé'
    if (status === 'partial') error = `${items.length - ok.length} élément(s) en échec`
    const sizeBytes = ok.reduce((sum, item) => sum + item.sizeBytes, 0)
    await log(
      status === 'succeeded'
        ? `Sauvegarde terminée : ${formatSize(sizeBytes)}`
        : `Sauvegarde ${status === 'partial' ? 'incomplète' : 'échouée'}`,
    )
    await db
      .update(backups)
      .set({ status, items, sizeBytes, error, logs, finishedAt: this.#now() })
      .where(eq(backups.id, id))
    await audit(db, {
      userId: row.backup.userId,
      username: row.backup.username ?? 'planification',
      action: 'backup.run',
      target: `${scope.project.slug}/${scope.env.slug}`,
      success: status === 'succeeded',
      details: { backupId: id, status, sizeBytes, trigger: row.backup.trigger },
    })
    if (status !== 'succeeded') {
      await this.options.notifications.notify(
        buildMessage({
          event: 'backup.failed',
          severity: status === 'failed' ? 'critical' : 'warning',
          title: `Sauvegarde ${status === 'failed' ? 'échouée' : 'incomplète'} · ${scope.project.name} / ${scope.env.name}`,
          summary: error ?? '',
          facts: [
            { label: 'Destination', value: row.destination?.name ?? '' },
            { label: 'Éléments', value: `${ok.length}/${items.length}` },
          ],
          details:
            items
              .filter((item) => item.status === 'failed')
              .map((item) => `${item.name} : ${item.error}`)
              .join('\n') || error,
          url: this.options.notifications.link(
            `/projets/${scope.project.slug}?env=${scope.env.slug}&onglet=sauvegardes`,
          ),
          linkLabel: 'Voir les sauvegardes',
          project: { id: scope.project.id, slug: scope.project.slug, name: scope.project.name },
          environment: { id: scope.env.id, slug: scope.env.slug, name: scope.env.name },
          incident: null,
          data: { backupId: id, status },
        }),
      )
    }
    if (status !== 'failed' && row.plan && row.destination) {
      await this.#prune(row.backup.environmentId, row.plan.keep, row.destination)
    }
    await this.#pruneFailed(row.backup.environmentId)
  }

  // --- Sauvegarde de Vercio ---------------------------------------------------------------

  async vercioPlan(): Promise<VercioBackupPlan | null> {
    const [row] = await this.options.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, VERCIO_BACKUP_KEY))
    return (row?.value as VercioBackupPlan | undefined) ?? null
  }

  async saveVercioPlan(plan: VercioBackupPlan | null): Promise<void> {
    const { db } = this.options
    if (!plan) {
      await db.delete(appSettings).where(eq(appSettings.key, VERCIO_BACKUP_KEY))
      return
    }
    await db
      .insert(appSettings)
      .values({ key: VERCIO_BACKUP_KEY, value: plan })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: plan } })
  }

  /** Met en file une sauvegarde de la base de Vercio. */
  async requestVercio(trigger: BackupTrigger, user: User): Promise<string> {
    const { db } = this.options
    const plan = await this.vercioPlan()
    if (!plan) throw new StepError('Configurez d’abord la sauvegarde de Vercio')
    const [destination] = await db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, plan.destinationId))
    if (!destination) throw new StepError('Destination supprimée')
    const [running] = await db
      .select({ id: backups.id })
      .from(backups)
      .where(and(isNull(backups.environmentId), eq(backups.status, 'running')))
      .limit(1)
    if (running) return running.id
    const id = await this.#createVercioBackup(destination, trigger, user)
    this.#enqueue(() => this.#backup(id))
    return id
  }

  /** Envoie un fichier (chiffré si besoin) et calcule l'empreinte HMAC de ce qui est stocké. */
  async #upload(
    store: BackupStore,
    key: string,
    staged: string,
    passphrase: string | null,
  ): Promise<{ sizeBytes: number; hmac: string }> {
    const mac = this.options.box.hmac('backup')
    const source = createReadStream(staged)
    const stored = passphrase ? source.pipe(await encryptStream(passphrase)) : source
    const sizeBytes = await store.put(key, stored.pipe(hashing(mac)))
    return { sizeBytes, hmac: mac.digest('hex') }
  }

  /**
   * Télécharge un fichier, vérifie son empreinte avant tout usage (un fichier modifié dans la
   * destination ne doit jamais être restauré), puis le déchiffre.
   */
  async #download(
    store: BackupStore,
    key: string,
    item: BackupItem,
    passphrase: string | null,
    target: string,
  ): Promise<void> {
    if (!item.hmac) {
      throw new StepError(
        `${item.name} : sauvegarde sans empreinte d’intégrité (version antérieure), restauration refusée`,
      )
    }
    const raw = `${target}.brut`
    const mac = this.options.box.hmac('backup')
    await pipeline(await store.get(key), hashing(mac), createWriteStream(raw, { mode: 0o600 }))
    const expected = Buffer.from(item.hmac, 'hex')
    const actual = mac.digest()
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await rm(raw, { force: true })
      throw new StepError(
        `${item.name} : fichier modifié dans la destination depuis la sauvegarde, restauration refusée`,
      )
    }
    const steps: (Readable | Transform | NodeJS.WritableStream)[] = [createReadStream(raw)]
    if (passphrase) steps.push(decryptStream(passphrase))
    steps.push(createWriteStream(target, { mode: 0o600 }))
    try {
      await pipeline(steps as never)
    } finally {
      await rm(raw, { force: true })
    }
  }

  /** Ligne d'historique d'une sauvegarde de Vercio, prête à être exécutée. */
  async #createVercioBackup(
    destination: DestinationRow,
    trigger: BackupTrigger,
    user: User,
  ): Promise<string> {
    const { db } = this.options
    const started = this.#now()
    const stamp = started
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replaceAll(':', '-')
    const [created] = await db
      .insert(backups)
      .values({
        environmentId: null,
        destinationId: destination.id,
        status: 'running',
        trigger,
        location: '',
        encrypted: !!destination.passphraseEnc,
        userId: user?.id ?? null,
        username: user?.username ?? null,
        startedAt: started,
      })
      .returning({ id: backups.id })
    const id = created!.id
    await db
      .update(backups)
      .set({ location: `${VERCIO_LOCATION}/${stamp}-${id.slice(0, 8)}` })
      .where(eq(backups.id, id))
    return id
  }

  async #backupVercio(
    backup: typeof backups.$inferSelect,
    destination: DestinationRow | null,
  ): Promise<void> {
    const { db } = this.options
    const id = backup.id
    const logs: string[] = []
    const log = async (line: string) => {
      logs.push(`${this.#now().toISOString()} ${line}`)
      await db.update(backups).set({ logs }).where(eq(backups.id, id))
    }
    const item: BackupItem = {
      key: VERCIO_ITEM,
      kind: 'database',
      name: 'vercio',
      engine: 'postgres',
      file: null,
      sizeBytes: 0,
      status: 'failed',
      error: null,
    }
    const dir = join(this.#staging, id)
    let error: string | null = null
    try {
      if (!destination) throw new StepError('Destination supprimée')
      const store = this.store(destination)
      const passphrase = this.passphrase(destination)
      await mkdir(dir, { recursive: true })
      await log(
        `Sauvegarde de Vercio vers « ${destination.name} » (${store.location}), dossier ${backup.location}${passphrase ? ', chiffrée' : ''}`,
      )
      const staged = join(dir, 'vercio.sql.gz')
      await this.#dumpVercio(staged, log)
      const file = `databases/vercio.sql.gz${passphrase ? '.enc' : ''}`
      Object.assign(
        item,
        await this.#upload(store, `${backup.location}/${file}`, staged, passphrase),
      )
      item.migrations = await this.#migrationCount()
      item.file = file
      item.status = 'ok'
      await store.put(
        `${backup.location}/${MANIFEST}`,
        Readable.from([
          JSON.stringify(
            {
              format: 1,
              vercio: 'sauvegarde de Vercio',
              // Restauration refusée si la sauvegarde vient d'une version plus récente.
              migrations: await this.#migrationCount(),
              createdAt: backup.startedAt.toISOString(),
              encrypted: !!passphrase,
              items: [item],
            },
            null,
            2,
          ),
        ]),
      )
      await log(`✓ base de Vercio : ${formatSize(item.sizeBytes)}`)
    } catch (cause) {
      error = item.error = (cause as Error).message
      await log(`Échec : ${error}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    const status: BackupStatus = error ? 'failed' : 'succeeded'
    await db
      .update(backups)
      .set({
        status,
        items: [item],
        sizeBytes: item.sizeBytes,
        error,
        logs,
        finishedAt: this.#now(),
      })
      .where(eq(backups.id, id))
    await audit(db, {
      userId: backup.userId,
      username: backup.username ?? 'planification',
      action: 'backup.run',
      target: 'vercio',
      success: !error,
      details: { backupId: id, status, sizeBytes: item.sizeBytes, trigger: backup.trigger },
    })
    if (error) {
      await this.options.notifications.notify(
        buildMessage({
          event: 'backup.failed',
          severity: 'critical',
          title: 'Sauvegarde de Vercio échouée',
          summary: error,
          facts: [{ label: 'Destination', value: destination?.name ?? '' }],
          details: error,
          url: this.options.notifications.link('/parametres#sauvegardes'),
          linkLabel: 'Voir les sauvegardes',
          project: null,
          environment: null,
          incident: null,
          data: { backupId: id, status, scope: 'vercio' },
        }),
      )
    }
    const plan = await this.vercioPlan()
    if (!error && plan && destination) await this.#prune(null, plan.keep, destination)
    await this.#pruneFailed(null)
  }

  /**
   * `pg_dump` dans un conteneur `postgres` de la même version que le serveur, sur le réseau de
   * Vercio (`--network container:<vercio>`) : le nom d'hôte de DATABASE_URL s'y résout comme
   * pour Vercio. Hors conteneur (développement) : réseau de l'hôte.
   */
  async #vercioHelper(): Promise<{ image: string; network: string }> {
    const [version] = (await this.options.db.execute(
      sql`select current_setting('server_version_num')::int / 10000 as major`,
    )) as unknown as { major: number }[]
    const self = await this.#docker(['inspect', '--format', '{{.Id}}', hostname()])
    return {
      image: `postgres:${version?.major ?? 17}`,
      network: self.code === 0 ? `container:${hostname()}` : 'host',
    }
  }

  async #migrationCount(): Promise<number> {
    const [row] = (await this.options.db.execute(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    )) as unknown as { count: number }[]
    return row?.count ?? 0
  }

  async #dumpVercio(file: string, log: (line: string) => Promise<void>): Promise<void> {
    const { image, network } = await this.#vercioHelper()
    await log(`→ base de Vercio (pg_dump, image ${image})…`)
    const out = createWriteStream(file, { mode: 0o600 })
    const sink = createGzip()
    const written = pipeline(sink, out)
    const { code, errors } = await this.#docker(
      [
        'run',
        '--rm',
        '--network',
        network,
        // Adresse passée par l'environnement : absente de la ligne de commande (`ps`).
        '-e',
        'VERCIO_DUMP_URL',
        image,
        'sh',
        '-c',
        'exec pg_dump --clean --if-exists --no-owner --no-privileges "$VERCIO_DUMP_URL"',
      ],
      { stdout: sink, env: { VERCIO_DUMP_URL: this.options.databaseUrl } },
    )
    await written
    if (code !== 0) {
      throw new StepError(errors.at(-1) ?? `export impossible (code ${code})`)
    }
    if ((await stat(file)).size < 20) throw new StepError('export vide')
  }

  // --- Restauration de Vercio --------------------------------------------------------------

  /** Restauration de Vercio en cours ou échouée ; une réussite redémarre Vercio. */
  get vercioRestore(): VercioRestoreState | null {
    return this.#vercioRestore
  }

  async requestVercioRestore(backupId: string, user: User): Promise<void> {
    const { db } = this.options
    if (this.#vercioRestore?.status === 'running') {
      throw new StepError('Une restauration de Vercio est déjà en cours')
    }
    const [row] = await db
      .select({ backup: backups, destination: backupDestinations })
      .from(backups)
      .leftJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
      .where(and(eq(backups.id, backupId), isNull(backups.environmentId)))
    if (!row) throw new StepError('Sauvegarde introuvable')
    if (!(row.backup.items as BackupItem[]).some((item) => item.status === 'ok')) {
      throw new StepError('Cette sauvegarde ne contient pas la base de Vercio')
    }
    if (!row.destination) throw new StepError('Destination supprimée')
    const [busy] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(inArray(deployments.status, ['queued', 'running']))
      .limit(1)
    if (busy) throw new StepError('Un déploiement est en cours : attendez sa fin')
    const [running] = await db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.status, 'running'))
      .limit(1)
    if (running) throw new StepError('Une sauvegarde est en cours : attendez sa fin')
    this.#vercioRestore = {
      backupId,
      status: 'running',
      error: null,
      logs: [],
      startedAt: this.#now().toISOString(),
    }
    this.#enqueue(() => this.#restoreVercio(backupId, user))
  }

  /**
   * Remplace la base de Vercio par une sauvegarde : contrôle de version, sauvegarde de
   * sécurité, import en une seule transaction (tout ou rien), historique des sauvegardes
   * conservé, puis redémarrage (état en mémoire et sessions repartent de la base restaurée).
   */
  async #restoreVercio(backupId: string, user: User): Promise<void> {
    const { db } = this.options
    const state = this.#vercioRestore!
    const log = (line: string) => {
      state.logs.push(`${this.#now().toISOString()} ${line}`)
    }
    const dir = join(this.#staging, `restauration-vercio-${backupId}`)
    try {
      const [row] = await db
        .select({ backup: backups, destination: backupDestinations })
        .from(backups)
        .innerJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
        .where(eq(backups.id, backupId))
      if (!row) throw new StepError('Sauvegarde ou destination introuvable')
      const { backup, destination } = row
      const store = this.store(destination)
      const item = (backup.items as BackupItem[]).find((entry) => entry.status === 'ok')!
      log(`Restauration de Vercio depuis la sauvegarde du ${backup.startedAt.toISOString()}`)

      // 1. Version (notée en base, pas dans le manifeste de la destination) : une base plus
      //    récente que ce Vercio ne se relit pas.
      if (item.migrations !== undefined && item.migrations > (await this.#migrationCount())) {
        throw new StepError(
          'Sauvegarde faite par une version plus récente de Vercio : mettez Vercio à jour d’abord',
        )
      }

      // 2. Téléchargement et déchiffrement avant de toucher à la base.
      await mkdir(dir, { recursive: true })
      const file = join(dir, 'vercio.sql.gz')
      const passphrase = backup.encrypted ? this.passphrase(destination) : null
      if (backup.encrypted && !passphrase) {
        throw new StepError('Sauvegarde chiffrée, mais la destination n’a plus de phrase')
      }
      log('↓ téléchargement et contrôle d’intégrité…')
      await this.#download(store, `${backup.location}/${item.file}`, item, passphrase, file)

      // 3. Sauvegarde de sécurité de l'état actuel : on peut revenir en arrière.
      log('→ sauvegarde de sécurité de l’état actuel…')
      const plan = await this.vercioPlan()
      const [planDestination] = plan
        ? await db
            .select()
            .from(backupDestinations)
            .where(eq(backupDestinations.id, plan.destinationId))
        : []
      const safetyId = await this.#createVercioBackup(
        planDestination ?? destination,
        'manual',
        user,
      )
      await this.#backup(safetyId)
      const [safety] = await db.select().from(backups).where(eq(backups.id, safetyId))
      if (safety?.status !== 'succeeded') {
        throw new StepError(`sauvegarde de sécurité impossible : ${safety?.error ?? 'échec'}`)
      }
      log(`✓ sauvegarde de sécurité (${formatSize(safety.sizeBytes)})`)

      // 4. Historique : les fichiers restent dans les destinations, on les garde visibles
      //    quelle que soit la date de la base restaurée.
      const history = await db.select().from(backups)

      // 5. Import en une transaction : en cas d'erreur, la base reste telle quelle.
      log('→ import de la base…')
      const { image, network } = await this.#vercioHelper()
      const { code, errors } = await this.#docker(
        [
          'run',
          '--rm',
          '-i',
          '--network',
          network,
          '-e',
          'VERCIO_DUMP_URL',
          image,
          'sh',
          '-c',
          'exec psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$VERCIO_DUMP_URL"',
        ],
        {
          stdin: createReadStream(file).pipe(createGunzip()),
          env: { VERCIO_DUMP_URL: this.options.databaseUrl },
        },
      )
      if (code !== 0) {
        const reason =
          errors.filter((line) => /ERROR|FATAL/.test(line)).at(-1) ??
          errors.at(-1) ??
          `code ${code}`
        throw new StepError(`import refusé, base inchangée : ${reason}`)
      }
      await this.#keepHistory(history)
      log('✓ base restaurée')
      await audit(db, {
        userId: null,
        username: user?.username ?? null,
        action: 'backup.restore',
        target: 'vercio',
        success: true,
        details: { backupId, safetyBackupId: safetyId, from: backup.startedAt.toISOString() },
      })
      log('Redémarrage de Vercio…')
      this.options.log.warn('Base de Vercio restaurée : redémarrage')
      this.options.restart()
    } catch (cause) {
      state.status = 'failed'
      state.error = (cause as Error).message
      log(`Échec : ${state.error}`)
      await audit(db, {
        userId: user?.id ?? null,
        username: user?.username ?? null,
        action: 'backup.restore',
        target: 'vercio',
        success: false,
        details: { backupId, error: state.error },
      }).catch(() => {})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Réinsère l'historique des sauvegardes d'avant la restauration (sans ce qui n'existe plus). */
  async #keepHistory(history: (typeof backups.$inferSelect)[]): Promise<void> {
    const { db } = this.options
    const ids = async (rows: Promise<{ id: string }[]>) => new Set((await rows).map((r) => r.id))
    const envIds = await ids(db.select({ id: environments.id }).from(environments))
    const destinationIds = await ids(
      db.select({ id: backupDestinations.id }).from(backupDestinations),
    )
    const userIds = await ids(db.select({ id: users.id }).from(users))
    for (const row of history) {
      if (row.environmentId && !envIds.has(row.environmentId)) continue
      const values = {
        ...row,
        destinationId:
          row.destinationId && destinationIds.has(row.destinationId) ? row.destinationId : null,
        userId: row.userId && userIds.has(row.userId) ? row.userId : null,
      }
      await db
        .insert(backups)
        .values(values)
        .onConflictDoUpdate({ target: backups.id, set: values })
    }
  }

  async #dumpVolume(volume: string, file: string): Promise<void> {
    const out = createWriteStream(file, { mode: 0o600 })
    const written = finished(out)
    const { code, errors } = await this.#docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${volume}:/data:ro`,
        BACKUP_HELPER_IMAGE,
        'tar',
        'czf',
        '-',
        '-C',
        '/data',
        '.',
      ],
      { stdout: out },
    )
    // Fichier fermé avant de le relire (ou de vider le dossier de travail).
    await written
    if (code !== 0) throw new StepError(errors.at(-1) ?? `copie impossible (code ${code})`)
  }

  async #dumpDatabase(
    containers: ContainerView[],
    service: string,
    engine: DatabaseEngine,
    file: string,
  ): Promise<void> {
    const container = containers.find(
      (item) => item.service === service && item.state === 'running' && !item.relayFor,
    )
    if (!container) throw new StepError('service arrêté : démarrez-le pour exporter la base')
    const out = createWriteStream(file, { mode: 0o600 })
    const sink = engine === 'mongo' ? null : createGzip()
    const written = sink ? pipeline(sink, out) : finished(out)
    const { code, errors } = await this.#docker(
      ['exec', container.id, 'sh', '-c', dumpScript(engine)],
      { stdout: sink ?? out },
    )
    await written
    if (code !== 0) {
      throw new StepError(
        errors.filter((line) => !/warning/i.test(line)).at(-1) ??
          `export impossible (code ${code})`,
      )
    }
    if ((await stat(file)).size < 20) throw new StepError('export vide')
  }

  /** Garde les `keep` dernières sauvegardes réussies (ou incomplètes) de l'environnement. */
  async #prune(
    environmentId: string | null,
    keep: number,
    destination: DestinationRow,
  ): Promise<void> {
    const { db } = this.options
    const rows = await db
      .select({ id: backups.id, location: backups.location, destinationId: backups.destinationId })
      .from(backups)
      .where(and(sameScope(environmentId), inArray(backups.status, ['succeeded', 'partial'])))
      .orderBy(desc(backups.startedAt))
    for (const old of rows.slice(keep)) {
      try {
        // Sauvegarde envoyée ailleurs (destination changée) : on la retire de cette destination-là.
        const [target] =
          old.destinationId === destination.id
            ? [destination]
            : old.destinationId
              ? await db
                  .select()
                  .from(backupDestinations)
                  .where(eq(backupDestinations.id, old.destinationId))
              : []
        if (target) await this.store(target).removeFolder(old.location)
        await db.delete(backups).where(eq(backups.id, old.id))
      } catch (error) {
        this.options.log.warn({ err: error, backup: old.id }, 'Ancienne sauvegarde non supprimée')
      }
    }
  }

  async #pruneFailed(environmentId: string | null): Promise<void> {
    const { db } = this.options
    const failed = await db
      .select({ id: backups.id })
      .from(backups)
      .where(and(sameScope(environmentId), eq(backups.status, 'failed')))
      .orderBy(desc(backups.startedAt))
    const old = failed.slice(FAILED_KEPT).map((row) => row.id)
    if (old.length) await db.delete(backups).where(inArray(backups.id, old))
  }

  /** Supprime une sauvegarde de l'historique et de sa destination. */
  async remove(id: string): Promise<void> {
    const { db } = this.options
    const [row] = await db
      .select({ backup: backups, destination: backupDestinations })
      .from(backups)
      .leftJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
      .where(eq(backups.id, id))
    if (!row) return
    if (row.backup.status === 'running') throw new StepError('Sauvegarde en cours')
    if (row.destination && row.backup.location) {
      await this.store(row.destination).removeFolder(row.backup.location)
    }
    await db.delete(backups).where(eq(backups.id, id))
  }

  /** Fichier d'une sauvegarde, déchiffré. */
  async download(id: string, key: string): Promise<{ stream: Readable; name: string }> {
    const { db } = this.options
    const [row] = await db
      .select({ backup: backups, destination: backupDestinations })
      .from(backups)
      .leftJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
      .where(eq(backups.id, id))
    const item = (row?.backup.items as BackupItem[] | undefined)?.find(
      (entry) => entry.key === key && entry.status === 'ok' && entry.file,
    )
    if (!row || !item) throw new StepError('Fichier introuvable')
    if (!row.destination) throw new StepError('Destination supprimée')
    const raw = await this.store(row.destination).get(`${row.backup.location}/${item.file}`)
    const name = item
      .file!.split('/')
      .at(-1)!
      .replace(/\.enc$/, '')
    if (!row.backup.encrypted) return { stream: raw, name }
    const passphrase = this.passphrase(row.destination)
    if (!passphrase) {
      throw new StepError(
        'Sauvegarde chiffrée, mais la destination n’a plus de phrase de chiffrement',
      )
    }
    const plain = decryptStream(passphrase)
    raw.on('error', (error) => plain.destroy(error))
    return { stream: raw.pipe(plain), name }
  }

  // --- Restauration ------------------------------------------------------------------------

  async requestRestore(backupId: string, keys: string[], user: User): Promise<string> {
    const { db } = this.options
    const [row] = await db.select().from(backups).where(eq(backups.id, backupId))
    if (!row) throw new StepError('Sauvegarde introuvable')
    if (!row.environmentId) {
      throw new StepError('La base de Vercio se restaure à la main (voir le README)')
    }
    const environmentId = row.environmentId
    const available = (row.items as BackupItem[]).filter((item) => item.status === 'ok')
    const unknown = keys.filter((key) => !available.some((item) => item.key === key))
    if (unknown.length) throw new StepError(`Élément absent de la sauvegarde : ${unknown[0]}`)
    const [busy] = await db
      .select({ id: backupRestores.id })
      .from(backupRestores)
      .innerJoin(backups, eq(backups.id, backupRestores.backupId))
      .where(and(eq(backups.environmentId, environmentId), eq(backupRestores.status, 'running')))
      .limit(1)
    if (busy) throw new StepError('Une restauration est déjà en cours sur cet environnement')
    const [created] = await db
      .insert(backupRestores)
      .values({
        backupId,
        status: 'running',
        items: keys,
        userId: user?.id ?? null,
        username: user?.username ?? null,
        startedAt: this.#now(),
      })
      .returning({ id: backupRestores.id })
    this.#enqueue(() => this.#restore(created!.id))
    return created!.id
  }

  async #restore(restoreId: string): Promise<void> {
    const { db, host } = this.options
    const [row] = await db
      .select({
        restore: backupRestores,
        backup: backups,
        destination: backupDestinations,
        env: environments,
        project: projects,
      })
      .from(backupRestores)
      .innerJoin(backups, eq(backups.id, backupRestores.backupId))
      .innerJoin(environments, eq(environments.id, backups.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .leftJoin(backupDestinations, eq(backupDestinations.id, backups.destinationId))
      .where(eq(backupRestores.id, restoreId))
    if (!row) return
    const logs: string[] = []
    const log = async (line: string) => {
      logs.push(`${this.#now().toISOString()} ${line}`)
      await db.update(backupRestores).set({ logs }).where(eq(backupRestores.id, restoreId))
    }
    const dir = join(this.#staging, `restauration-${restoreId}`)
    const keys = new Set(row.restore.items)
    const items = (row.backup.items as BackupItem[]).filter((item) => keys.has(item.key))
    const name = composeProjectName(row.project.slug, row.env.slug)
    let error: string | null = null
    // Conteneurs arrêtés par la restauration : redémarrés à la fin, même en cas d'échec.
    let toRestart: ContainerView[] = []
    try {
      if (!row.destination) throw new StepError('Destination supprimée')
      const store = this.store(row.destination)
      const passphrase = row.backup.encrypted ? this.passphrase(row.destination) : null
      if (row.backup.encrypted && !passphrase) {
        throw new StepError(
          'Sauvegarde chiffrée, mais la destination n’a plus de phrase de chiffrement',
        )
      }
      await mkdir(dir, { recursive: true })
      await log(`Restauration de la sauvegarde du ${row.backup.startedAt.toISOString()}`)

      // 1. Téléchargement (et déchiffrement) avant de toucher à quoi que ce soit.
      const staged = new Map<string, string>()
      for (const item of items) {
        const file = join(dir, item.file!.replaceAll('/', '__').replace(/\.enc$/, ''))
        await log(`↓ ${item.name}…`)
        await this.#download(store, `${row.backup.location}/${item.file}`, item, passphrase, file)
        staged.set(item.key, file)
      }

      // 2. Arrêt de l'environnement (les bases à réimporter restent en marche).
      const containers = (await host.listContainers(name)).filter(
        (item) => item.state === 'running',
      )
      const databases = new Set(
        items.filter((item) => item.kind === 'database').map((item) => item.name),
      )
      const volumes = new Set(
        items.filter((item) => item.kind === 'volume').map((item) => item.name),
      )
      const usesRestoredVolume = async (container: ContainerView) => {
        const details = await host.containerDetails(container.id)
        return (details?.mounts ?? []).some((mount) => volumes.has(mount.source))
      }
      const stopped: ContainerView[] = []
      for (const container of containers) {
        if (databases.has(container.service) && !(await usesRestoredVolume(container))) continue
        stopped.push(container)
      }
      toRestart = stopped
      if (stopped.length) {
        await log(`Arrêt de ${stopped.map((item) => item.service).join(', ')}`)
        await Promise.all(stopped.map((item) => host.containerAction(item.id, 'stop')))
      }

      // 3. Volumes : contenu remplacé.
      for (const item of items.filter((entry) => entry.kind === 'volume')) {
        await log(`→ volume ${item.name}`)
        const { code, errors } = await this.#docker(
          [
            'run',
            '--rm',
            '-i',
            '--network',
            'none',
            '-v',
            `${item.name}:/data`,
            BACKUP_HELPER_IMAGE,
            'sh',
            '-c',
            'find /data -mindepth 1 -delete && tar xzf - -C /data',
          ],
          { stdin: createReadStream(staged.get(item.key)!) },
        )
        if (code !== 0)
          throw new StepError(`volume ${item.name} : ${errors.at(-1) ?? `code ${code}`}`)
      }

      // 4. Bases : le conteneur doit tourner (relancé s'il utilisait un volume restauré).
      for (const item of items.filter((entry) => entry.kind === 'database')) {
        let container = (await host.listContainers(name)).find(
          (entry) => entry.service === item.name && !entry.relayFor,
        )
        if (!container) throw new StepError(`base ${item.name} : conteneur introuvable`)
        if (container.state !== 'running') {
          await host.containerAction(container.id, 'start')
          toRestart = toRestart.filter((entry) => entry.id !== container!.id)
          container = { ...container, state: 'running' }
        }
        await log(`→ base ${item.name}`)
        const file = createReadStream(staged.get(item.key)!)
        const input = item.engine === 'mongo' ? file : file.pipe(createGunzip())
        const { code, errors } = await this.#docker(
          ['exec', '-i', container.id, 'sh', '-c', restoreScript(item.engine!)],
          { stdin: input },
        )
        if (code !== 0)
          throw new StepError(`base ${item.name} : ${errors.at(-1) ?? `code ${code}`}`)
        // Attendu avec `pg_dumpall --clean` : le rôle courant ne peut pas être recréé.
        const warnings = errors.filter(
          (line) =>
            /ERROR|error/.test(line) &&
            !/current user cannot be dropped|role "[^"]+" already exists/.test(line),
        )
        if (warnings.length)
          await log(`  ${warnings.length} avertissement(s), ex. : ${warnings[0]}`)
      }
    } catch (cause) {
      error = (cause as Error).message
      await log(`Échec : ${error}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
      if (toRestart.length) {
        await log(`Redémarrage de ${toRestart.map((item) => item.service).join(', ')}`)
        for (const container of toRestart) {
          await host.containerAction(container.id, 'start').catch(async (cause: unknown) => {
            await log(`✗ ${container.service} : ${(cause as Error).message}`)
          })
        }
      }
    }
    await log(error ? 'Restauration échouée' : 'Restauration terminée')
    await db
      .update(backupRestores)
      .set({ status: error ? 'failed' : 'succeeded', error, logs, finishedAt: this.#now() })
      .where(eq(backupRestores.id, restoreId))
    await audit(db, {
      userId: row.restore.userId,
      username: row.restore.username,
      action: 'backup.restore',
      target: `${row.project.slug}/${row.env.slug}`,
      success: !error,
      details: { backupId: row.backup.id, restoreId, items: row.restore.items },
    })
  }

  /** Destinations utilisées par un plan : suppression interdite. */
  async destinationInUse(id: string): Promise<boolean> {
    const [used] = await this.options.db
      .select({ id: backupPlans.environmentId })
      .from(backupPlans)
      .where(eq(backupPlans.destinationId, id))
      .limit(1)
    return !!used || (await this.vercioPlan())?.destinationId === id
  }
}

/** Laisse passer les données en alimentant l'empreinte. */
function hashing(mac: Hmac): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      mac.update(chunk)
      callback(null, chunk)
    },
  })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  const units = ['Kio', 'Mio', 'Gio', 'Tio']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`
}

export { StepError as BackupError }
