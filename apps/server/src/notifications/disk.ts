import { existsSync } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { and, eq, isNull, like } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { DiskUsageView } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { notificationIncidents } from '../db/schema.js'
import { buildMessage } from './message.js'
import type { NotificationService } from './service.js'

const GIB = 1024 ** 3
/** Système de fichiers overlay : `/` d'un conteneur, sur le disque des images Docker. */
const OVERLAY_MAGIC = 0x794c7630

export interface DiskMeasure {
  /** Identifiant du système de fichiers : deux chemins sur le même disque ne comptent qu'une fois. */
  device: string
  overlay: boolean
  totalBytes: number
  freeBytes: number
  freeInodesRatio: number | null
}

export async function measureDisk(path: string): Promise<DiskMeasure> {
  // Dossier pas encore créé (aucun déploiement) : son plus proche parent est sur le même disque.
  let target = resolve(path)
  while (!existsSync(target) && dirname(target) !== target) target = dirname(target)
  const [fs, info] = await Promise.all([statfs(target), stat(target)])
  return {
    device: String(info.dev),
    overlay: fs.type === OVERLAY_MAGIC,
    totalBytes: fs.blocks * fs.bsize,
    // Espace utilisable par un processus non root (bavail), pas l'espace libre brut.
    freeBytes: fs.bavail * fs.bsize,
    freeInodesRatio: fs.files > 0 ? fs.ffree / fs.files : null,
  }
}

/** Seuils : alerte sous max(10 %, 5 Gio), critique sous max(5 %, 2 Gio), fin au-dessus de +5 points. */
export function thresholds(totalBytes: number) {
  const low = Math.min(Math.max(0.1 * totalBytes, 5 * GIB), 0.5 * totalBytes)
  const critical = Math.min(Math.max(0.05 * totalBytes, 2 * GIB), 0.25 * totalBytes)
  return { low, critical, recover: low + 0.05 * totalBytes }
}

type Level = DiskUsageView['level']

export function diskLevel(measure: DiskMeasure, previous: Level): Level {
  const limits = thresholds(measure.totalBytes)
  const inodesLow = measure.freeInodesRatio !== null && measure.freeInodesRatio < 0.1
  const inodesCritical = measure.freeInodesRatio !== null && measure.freeInodesRatio < 0.05
  if (measure.freeBytes < limits.critical || inodesCritical) return 'critical'
  if (measure.freeBytes < limits.low || inodesLow) return 'low'
  // Hystérésis : une alerte ouverte reste ouverte tant que l'espace n'est pas nettement revenu.
  if (previous !== 'ok' && measure.freeBytes < limits.recover) return 'low'
  return 'ok'
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * GIB) return `${(bytes / 1024 / GIB).toFixed(1)} Tio`
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} Gio`
  return `${Math.round(bytes / 1024 ** 2)} Mio`
}

interface WatchedPath {
  path: string
  label: string
  /** Mesuré seulement s'il s'agit de l'overlay de Docker (Vercio dans un conteneur). */
  overlayOnly?: boolean
}

export interface DiskWatcherOptions {
  db: Database
  notifications: NotificationService
  log: FastifyBaseLogger
  dataDir: string
  intervalMs?: number
  measure?: (path: string) => Promise<DiskMeasure>
}

/**
 * Espace disque : le disque des données de Vercio, et celui des images et conteneurs Docker
 * quand Vercio tourne lui-même dans un conteneur. Une alerte à l'ouverture, une à l'aggravation
 * (critique), une au retour à la normale ; jamais à chaque mesure.
 */
export class DiskWatcher {
  readonly #levels = new Map<string, Level>()
  #usage: DiskUsageView[] = []
  #timer: NodeJS.Timeout | null = null
  #restored = false

  constructor(private readonly options: DiskWatcherOptions) {}

  get paths(): WatchedPath[] {
    return [
      { path: '/', label: 'images et conteneurs Docker', overlayOnly: true },
      { path: this.options.dataDir, label: 'données de Vercio' },
    ]
  }

  start(): void {
    if (this.#timer) return
    const run = () =>
      void this.check().catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'Mesure de l’espace disque impossible')
      })
    this.#timer = setInterval(run, this.options.intervalMs ?? 5 * 60_000)
    this.#timer.unref()
    run()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Dernières mesures (tableau de bord). */
  usage(): DiskUsageView[] {
    return this.#usage
  }

  async check(): Promise<DiskUsageView[]> {
    if (!this.#restored) await this.restore()
    const measure = this.options.measure ?? measureDisk
    const devices = new Set<string>()
    const usage: DiskUsageView[] = []
    for (const watched of this.paths) {
      let result: DiskMeasure
      try {
        result = await measure(watched.path)
      } catch {
        continue
      }
      if (watched.overlayOnly && !result.overlay) continue
      if (devices.has(result.device)) continue
      devices.add(result.device)
      const previous = this.#levels.get(watched.path) ?? 'ok'
      const level = diskLevel(result, previous)
      usage.push({
        path: watched.path,
        label: watched.label,
        totalBytes: result.totalBytes,
        freeBytes: result.freeBytes,
        freeInodesRatio: result.freeInodesRatio,
        level,
        lowThresholdBytes: Math.round(thresholds(result.totalBytes).low),
        measuredAt: new Date().toISOString(),
      })
      if (level !== previous) {
        this.#levels.set(watched.path, level)
        await this.transition(watched, previous, level, result)
      }
    }
    this.#usage = usage
    return usage
  }

  /** Alertes ouvertes avant un redémarrage : pas de nouveau message pour le même état. */
  private async restore(): Promise<void> {
    try {
      const open = await this.options.db
        .select()
        .from(notificationIncidents)
        .where(
          and(isNull(notificationIncidents.resolvedAt), like(notificationIncidents.key, 'disk:%')),
        )
      for (const incident of open) {
        const level = (incident.data as { level?: Level }).level ?? 'low'
        this.#levels.set(incident.key.slice('disk:'.length), level)
      }
      this.#restored = true
    } catch {
      // Base indisponible : état en mémoire seulement, nouvel essai à la prochaine mesure.
    }
  }

  private async transition(
    watched: WatchedPath,
    previous: Level,
    level: Level,
    measure: DiskMeasure,
  ): Promise<void> {
    const key = `disk:${watched.path}`
    const data = { level, freeBytes: measure.freeBytes, totalBytes: measure.totalBytes }
    let incident: { id: string } | undefined
    try {
      if (level === 'ok') {
        ;[incident] = await this.options.db
          .update(notificationIncidents)
          .set({ resolvedAt: new Date(), data })
          .where(and(eq(notificationIncidents.key, key), isNull(notificationIncidents.resolvedAt)))
          .returning()
      } else if (previous === 'ok') {
        ;[incident] = await this.options.db
          .insert(notificationIncidents)
          .values({ key, kind: 'disk', data, notified: true })
          .onConflictDoNothing()
          .returning()
      } else {
        ;[incident] = await this.options.db
          .update(notificationIncidents)
          .set({ data })
          .where(and(eq(notificationIncidents.key, key), isNull(notificationIncidents.resolvedAt)))
          .returning()
      }
    } catch (error) {
      // Disque plein : l'alerte part quand même (file de secours du service).
      this.options.log.warn({ err: error }, 'Incident disque non enregistré')
    }
    // Retour de critique à faible : rien à signaler.
    if (previous === 'critical' && level === 'low') return

    const limits = thresholds(measure.totalBytes)
    const percent = Math.round((measure.freeBytes / measure.totalBytes) * 100)
    const event =
      level === 'ok' ? 'disk.recovered' : level === 'critical' ? 'disk.critical' : 'disk.low'
    const title =
      level === 'ok'
        ? `Espace disque rétabli · ${watched.label}`
        : level === 'critical'
          ? `Espace disque critique · ${watched.label}`
          : `Espace disque faible · ${watched.label}`
    const summary =
      level === 'ok'
        ? `${formatBytes(measure.freeBytes)} libres (${percent} %).`
        : `${formatBytes(measure.freeBytes)} libres sur ${formatBytes(measure.totalBytes)} (${percent} %).${
            level === 'critical'
              ? ' Les déploiements et la base de données de Vercio risquent de s’arrêter : libérez de la place (docker system prune, anciennes images, logs).'
              : ' Pensez à libérer de la place (anciennes images, volumes inutilisés, logs).'
          }`
    await this.options.notifications.notify(
      buildMessage({
        event,
        severity: level === 'ok' ? 'success' : level === 'critical' ? 'critical' : 'warning',
        title,
        summary,
        facts: [
          { label: 'Disque', value: watched.label },
          { label: 'Chemin mesuré', value: watched.path },
          { label: 'Libre', value: formatBytes(measure.freeBytes) },
          { label: 'Seuil d’alerte', value: formatBytes(limits.low) },
          {
            label: 'Inodes libres',
            value:
              measure.freeInodesRatio === null
                ? ''
                : `${Math.round(measure.freeInodesRatio * 100)} %`,
          },
        ],
        url: this.options.notifications.link('/'),
        linkLabel: 'Ouvrir le tableau de bord',
        project: null,
        environment: null,
        incident: incident
          ? { id: incident.id, status: level === 'ok' ? 'resolved' : 'open' }
          : null,
        data: { path: watched.path, label: watched.label, ...data },
      }),
    )
  }
}
