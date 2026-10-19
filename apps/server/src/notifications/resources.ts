import { and, eq, gte, isNull, ne } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  composeProjectName,
  DEFAULT_RESOURCE_ALERT_SETTINGS,
  resourceAlertSettingsSchema,
  type ContainerStatsSample,
  type ResourceAlertSettings,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSettings, environments, notificationIncidents, projects } from '../db/schema.js'
import type { HostDriver } from '../docker/host-driver.js'
import type { StatsSampler } from '../docker/stats.js'
import { buildMessage } from './message.js'
import type { NotificationService } from './service.js'

export const RESOURCE_LIMITS = {
  /** Processeur : % d'un cœur (un service mono-thread saturé plafonne vers 100 %). */
  cpuPercent: 90,
  /** Mémoire : part de la limite du conteneur (ou de la mémoire de l'hôte). */
  memoryRatio: 0.9,
  /** Mesures moyennées (une toutes les 5 s) : 30 s, pour ignorer les pics brefs. */
  averageSamples: 6,
  /** Au-dessus du seuil depuis 2 min : un épisode commence. */
  sustainMs: 120_000,
  /** Sous le seuil depuis 2 min : l'épisode se termine. */
  clearMs: 120_000,
  /** Alerte quand les épisodes se répètent : 3 sur 24 h… */
  frequentEpisodes: 3,
  windowMs: 24 * 3_600_000,
  /** …ou quand un épisode dure 15 min. */
  longMs: 15 * 60_000,
  /** Silence pendant un déploiement de l'environnement et 2 min après. */
  deployGraceMs: 120_000,
  intervalMs: 30_000,
}

export type ResourceMetric = 'cpu' | 'memory'
export const RESOURCE_KIND = 'resources'

interface Target {
  id: string
  slug: string
  name: string
  project: { id: string; slug: string; name: string }
}

interface Track {
  service: string
  metric: ResourceMetric
  above: number | null
  below: number | null
  incidentId: string | null
  openedAt: number
  peak: number
  notified: boolean
}

export interface ResourceWatcherOptions {
  db: Database
  host: HostDriver
  stats: StatsSampler
  engine: { isDeploying(environmentId: string, graceMs?: number): boolean }
  notifications: NotificationService
  log: FastifyBaseLogger
  limits?: Partial<typeof RESOURCE_LIMITS>
  now?: () => number
}

/** Valeur mesurée en pourcentage : % d'un cœur, ou % de la limite mémoire. */
export function measure(samples: ContainerStatsSample[], metric: ResourceMetric, count: number) {
  const recent = samples.slice(-count)
  const values = recent.flatMap((sample) => {
    if (metric === 'cpu') return sample.cpuPercent === null ? [] : [sample.cpuPercent]
    return sample.memoryLimitBytes > 0 ? [(sample.memoryBytes / sample.memoryLimitBytes) * 100] : []
  })
  // Pas assez de mesures (conteneur qui démarre) : rien à conclure.
  if (values.length < Math.min(count, 2)) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Avec l'article : « saturation du processeur », « de la mémoire ». */
export const RESOURCE_SETTINGS_KEY = 'resource_alerts'

export async function loadResourceAlertSettings(db: Database): Promise<ResourceAlertSettings> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, RESOURCE_SETTINGS_KEY))
    .limit(1)
  const parsed = resourceAlertSettingsSchema.safeParse(row?.value)
  return parsed.success ? parsed.data : DEFAULT_RESOURCE_ALERT_SETTINGS
}

const LABELS: Record<ResourceMetric, string> = { cpu: 'du processeur', memory: 'de la mémoire' }

export function describeResource(metric: ResourceMetric, peak: number): string {
  return metric === 'cpu'
    ? `processeur à ${Math.round(peak)} % d’un cœur`
    : `mémoire à ${Math.round(peak)} % de sa limite`
}

/**
 * Saturation du processeur ou de la mémoire des services Vercio. Un épisode (2 min au-dessus
 * du seuil) est enregistré dans l'activité ; la notification part seulement quand ça se répète
 * (3 épisodes en 24 h) ou dure (15 min), une fois par 24 h et par service.
 */
export class ResourceWatcher {
  #limits: typeof RESOURCE_LIMITS
  readonly #tracks = new Map<string, Track>()
  readonly #now: () => number
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null

  constructor(private readonly options: ResourceWatcherOptions) {
    this.#limits = { ...RESOURCE_LIMITS, ...options.limits }
    this.#now = options.now ?? Date.now
  }

  start(): void {
    if (this.#timer) return
    const run = () => void this.check()
    this.#timer = setInterval(run, this.#limits.intervalMs)
    this.#timer.unref()
    run()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Une vérification (appelée par la minuterie, ou directement dans les tests). */
  check(): Promise<void> {
    this.#running ??= this.run()
      .catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'Surveillance CPU et mémoire impossible')
      })
      .finally(() => {
        this.#running = null
      })
    return this.#running
  }

  private async run(): Promise<void> {
    const { db, host, stats } = this.options
    const settings = await loadResourceAlertSettings(db)
    this.#limits = {
      ...RESOURCE_LIMITS,
      cpuPercent: settings.cpuPercent,
      memoryRatio: settings.memoryPercent / 100,
      sustainMs: settings.sustainMinutes * 60_000,
      clearMs: settings.sustainMinutes * 60_000,
      frequentEpisodes: settings.frequentEpisodes,
      longMs: settings.longMinutes * 60_000,
      ...this.options.limits,
    }
    if (!settings.enabled) {
      // Surveillance coupée : les épisodes en cours se terminent, plus aucune mesure.
      await this.adoptOpenEpisodes()
      for (const track of this.#tracks.values()) if (track.incidentId) await this.close(track)
      this.#tracks.clear()
      return
    }
    const rows = await db
      .select({ env: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
    const targets = new Map<string, Target>(
      rows.map(({ env, project }) => [
        composeProjectName(project.slug, env.slug),
        {
          id: env.id,
          slug: env.slug,
          name: env.name,
          project: { id: project.id, slug: project.slug, name: project.name },
        },
      ]),
    )
    const all = await host.composeContainerViews()
    const running = [...all].flatMap(([compose, list]) => {
      const target = targets.get(compose)
      return target
        ? list
            .filter((container) => container.state === 'running')
            .map((container) => ({ container, target, compose }))
        : []
    })
    await this.adoptOpenEpisodes()
    // Garde la mesure ouverte pour tous les conteneurs en marche.
    const history = stats.history(running.map((item) => item.container.id))
    const seen = new Set<string>()
    const now = this.#now()

    for (const { container, target, compose } of running) {
      const deploying = this.options.engine.isDeploying(target.id, this.#limits.deployGraceMs)
      for (const metric of ['cpu', 'memory'] as const) {
        const key = `${RESOURCE_KIND}:${compose}/${container.service}:${metric}`
        seen.add(key)
        if (deploying) continue
        const value = measure(history.get(container.id) ?? [], metric, this.#limits.averageSamples)
        if (value === null) continue
        const threshold =
          metric === 'cpu' ? this.#limits.cpuPercent : this.#limits.memoryRatio * 100
        await this.step(key, metric, value >= threshold, value, target, container.service, now)
      }
    }
    // Conteneur arrêté ou supprimé : l'épisode se termine sans bruit.
    for (const [key, track] of this.#tracks) {
      if (seen.has(key)) continue
      if (track.incidentId) await this.close(track)
      this.#tracks.delete(key)
    }
  }

  /**
   * Épisodes restés ouverts en base (Vercio redémarré pendant un épisode) : repris dans le
   * suivi, pour être poursuivis s'il sature encore ou fermés sinon.
   */
  private async adoptOpenEpisodes(): Promise<void> {
    const open = await this.options.db
      .select()
      .from(notificationIncidents)
      .where(
        and(
          eq(notificationIncidents.kind, RESOURCE_KIND),
          isNull(notificationIncidents.resolvedAt),
        ),
      )
    for (const row of open) {
      if (this.#tracks.get(row.key)?.incidentId === row.id) continue
      const data = row.data as { service?: string; metric?: ResourceMetric; peak?: number }
      this.#tracks.set(row.key, {
        service: data.service ?? '',
        metric: data.metric ?? 'cpu',
        above: null,
        below: null,
        incidentId: row.id,
        openedAt: row.openedAt.getTime(),
        peak: data.peak ?? 0,
        notified: row.notified,
      })
    }
  }

  private async step(
    key: string,
    metric: ResourceMetric,
    high: boolean,
    value: number,
    target: Target,
    service: string,
    now: number,
  ): Promise<void> {
    const track = this.#tracks.get(key) ?? {
      service,
      metric,
      above: null,
      below: null,
      incidentId: null,
      openedAt: 0,
      peak: 0,
      notified: false,
    }
    this.#tracks.set(key, track)
    if (high) {
      track.below = null
      track.above ??= now
      track.peak = Math.max(track.peak, value)
      if (!track.incidentId && now - track.above >= this.#limits.sustainMs) {
        await this.open(key, metric, track, target, service, now)
      } else if (
        track.incidentId &&
        !track.notified &&
        now - track.openedAt >= this.#limits.longMs
      ) {
        await this.alert(key, metric, track, target, service, 'long')
      }
      return
    }
    track.above = null
    if (!track.incidentId) {
      track.peak = 0
      return
    }
    track.below ??= now
    if (now - track.below >= this.#limits.clearMs) await this.close(track)
  }

  private async open(
    key: string,
    metric: ResourceMetric,
    track: Track,
    target: Target,
    service: string,
    now: number,
  ): Promise<void> {
    const { db } = this.options
    const [incident] = await db
      .insert(notificationIncidents)
      .values({
        key,
        kind: RESOURCE_KIND,
        environmentId: target.id,
        data: { service, metric, peak: track.peak, detail: describeResource(metric, track.peak) },
      })
      .onConflictDoNothing()
      .returning()
    if (!incident) return
    track.incidentId = incident.id
    track.openedAt = now
    track.notified = false
    const since = new Date(now - this.#limits.windowMs)
    const recent = await db
      .select({ id: notificationIncidents.id, notified: notificationIncidents.notified })
      .from(notificationIncidents)
      .where(
        and(
          eq(notificationIncidents.key, key),
          eq(notificationIncidents.kind, RESOURCE_KIND),
          gte(notificationIncidents.openedAt, since),
        ),
      )
    if (recent.length >= this.#limits.frequentEpisodes) {
      await this.alert(key, metric, track, target, service, 'frequent', recent.length)
    }
  }

  private async alert(
    key: string,
    metric: ResourceMetric,
    track: Track,
    target: Target,
    service: string,
    reason: 'frequent' | 'long',
    episodes?: number,
  ): Promise<void> {
    const { db, notifications } = this.options
    track.notified = true
    // Une seule notification par 24 h et par service : les épisodes suivants restent dans
    // l'activité.
    const [already] = await db
      .select({ id: notificationIncidents.id })
      .from(notificationIncidents)
      .where(
        and(
          eq(notificationIncidents.key, key),
          eq(notificationIncidents.kind, RESOURCE_KIND),
          eq(notificationIncidents.notified, true),
          ne(notificationIncidents.id, track.incidentId!),
          gte(notificationIncidents.openedAt, new Date(this.#now() - this.#limits.windowMs)),
        ),
      )
      .limit(1)
    await db
      .update(notificationIncidents)
      .set({ notified: true })
      .where(eq(notificationIncidents.id, track.incidentId!))
    if (already) return
    const where = `${service} · ${target.project.name} / ${target.name}`
    const detail = describeResource(metric, track.peak)
    await notifications.notify(
      buildMessage({
        event: 'container.resources',
        severity: 'warning',
        title: `${metric === 'cpu' ? 'Processeur saturé' : 'Mémoire presque pleine'} · ${where}`,
        summary:
          reason === 'frequent'
            ? `${episodes} épisodes de saturation ${LABELS[metric]} en 24 h (${detail}).`
            : `Saturation ${LABELS[metric]} depuis plus de ${Math.round(this.#limits.longMs / 60_000)} minutes (${detail}).`,
        facts: [
          { label: 'Service', value: service },
          { label: 'Pic', value: `${Math.round(track.peak)} %` },
        ],
        details:
          metric === 'memory'
            ? 'Au-delà de sa limite, le conteneur est tué par le système (code 137). Augmentez la limite (mem_limit) ou cherchez une fuite mémoire.'
            : 'Le service répond plus lentement. Vérifiez la charge (logs) ou donnez-lui plus de processeurs.',
        url: notifications.link(`/projets/${target.project.slug}?env=${target.slug}`),
        linkLabel: 'Voir le projet',
        project: target.project,
        environment: { id: target.id, slug: target.slug, name: target.name },
        incident: { id: track.incidentId!, status: 'open' },
        data: { service, metric, peak: track.peak, reason, ...(episodes ? { episodes } : {}) },
      }),
      { groupKey: `env:${target.id}` },
    )
  }

  private async close(track: Track): Promise<void> {
    await this.options.db
      .update(notificationIncidents)
      .set({
        resolvedAt: new Date(this.#now()),
        // Pic de tout l'épisode, pas seulement celui du début.
        data: {
          service: track.service,
          metric: track.metric,
          peak: track.peak,
          detail: describeResource(track.metric, track.peak),
        },
      })
      .where(
        and(
          eq(notificationIncidents.id, track.incidentId!),
          isNull(notificationIncidents.resolvedAt),
        ),
      )
    track.incidentId = null
    track.below = null
    track.above = null
    track.peak = 0
  }
}
