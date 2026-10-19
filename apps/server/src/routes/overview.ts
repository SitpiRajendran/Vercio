import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, gte } from 'drizzle-orm'
import {
  composeProjectName,
  type BackupSummary,
  type ContainerUsage,
  type ContainerView,
  type OverviewProject,
  type OverviewView,
  type ResourceAlert,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  backups,
  deployments,
  environments,
  environmentSources,
  notificationIncidents,
  projects,
  users,
} from '../db/schema.js'
import { toSummary } from '../deploy/engine.js'
import type { HostDriver } from '../docker/host-driver.js'
import type { StatsSampler } from '../docker/stats.js'
import { RESOURCE_KIND, RESOURCE_LIMITS } from '../notifications/resources.js'
import { appearanceOf } from './projects.js'

/** Mesures renvoyées par conteneur pour les mini-graphiques (2 minutes). */
const USAGE_HISTORY = 24

/** Page d'accueil : tous les projets, leurs environnements et leurs conteneurs en une requête. */
export const overviewRoutes: FastifyPluginAsync<{
  db: Database
  host: HostDriver
  stats: StatsSampler
}> = async (app, { db, host, stats }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }

  /** Projets Compose des environnements Vercio (nom Docker → environnement). */
  async function vercioComposeProjects(): Promise<Set<string>> {
    const rows = await db
      .select({ projectSlug: projects.slug, envSlug: environments.slug })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
    return new Set(rows.map((row) => composeProjectName(row.projectSlug, row.envSlug)))
  }

  app.get('/overview', viewer, async (): Promise<OverviewView> => {
    const [projectRows, envRows, sourceRows, lastRows, currentRows] = await Promise.all([
      db.select().from(projects).orderBy(projects.name),
      db.select().from(environments).orderBy(environments.createdAt),
      db
        .select({ environmentId: environmentSources.environmentId, mode: environmentSources.mode })
        .from(environmentSources),
      // Dernier déploiement, puis dernier déploiement réussi, de chaque environnement.
      db
        .selectDistinctOn([deployments.environmentId], {
          deployment: deployments,
          username: users.username,
        })
        .from(deployments)
        .leftJoin(users, eq(users.id, deployments.userId))
        .orderBy(deployments.environmentId, desc(deployments.createdAt)),
      db
        .selectDistinctOn([deployments.environmentId], {
          deployment: deployments,
          username: users.username,
        })
        .from(deployments)
        .leftJoin(users, eq(users.id, deployments.userId))
        .where(eq(deployments.status, 'succeeded'))
        .orderBy(deployments.environmentId, desc(deployments.createdAt)),
    ])

    const alertRows = await db
      .select()
      .from(notificationIncidents)
      .where(
        and(
          eq(notificationIncidents.kind, RESOURCE_KIND),
          gte(notificationIncidents.openedAt, new Date(Date.now() - RESOURCE_LIMITS.windowMs)),
        ),
      )
      .orderBy(notificationIncidents.openedAt)
    const alerts = new Map<string, ResourceAlert[]>()
    for (const row of alertRows) {
      const data = row.data as { service?: string; metric?: 'cpu' | 'memory'; peak?: number }
      if (!row.environmentId || !data.service || !data.metric) continue
      const list = alerts.get(row.environmentId) ?? []
      let alert = list.find((item) => item.service === data.service && item.metric === data.metric)
      if (!alert) {
        alert = {
          service: data.service,
          metric: data.metric,
          episodes: 0,
          active: false,
          peak: 0,
          lastAt: '',
        }
        list.push(alert)
      }
      alert.episodes++
      alert.active ||= row.resolvedAt === null
      alert.peak = Math.max(alert.peak, Math.round(data.peak ?? 0))
      alert.lastAt = row.openedAt.toISOString()
      alerts.set(row.environmentId, list)
    }

    const backupRows = await db
      .selectDistinctOn([backups.environmentId], {
        environmentId: backups.environmentId,
        status: backups.status,
        startedAt: backups.startedAt,
        finishedAt: backups.finishedAt,
      })
      .from(backups)
      .orderBy(backups.environmentId, desc(backups.startedAt))
    const lastBackups = new Map(backupRows.map((row) => [row.environmentId, row]))

    let containers = new Map<string, ContainerView[]>()
    let dockerError: string | null = null
    try {
      containers = await host.composeContainerViews()
    } catch (error) {
      dockerError = `Docker injoignable : ${error instanceof Error ? error.message : String(error)}`
    }
    const last = new Map(lastRows.map((row) => [row.deployment.environmentId, row]))
    const current = new Map(currentRows.map((row) => [row.deployment.environmentId, row]))

    const result: OverviewProject[] = projectRows.map((project) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      type: project.type,
      ...appearanceOf(project),
      environments: envRows
        .filter((env) => env.projectId === project.id)
        .map((env) => {
          const composeProject = composeProjectName(project.slug, env.slug)
          const lastRow = last.get(env.id)
          const currentRow = current.get(env.id)
          return {
            id: env.id,
            name: env.name,
            slug: env.slug,
            composeProject,
            locked: sourceRows.some(
              (source) => source.environmentId === env.id && source.mode === 'locked',
            ),
            lastDeployment: lastRow ? toSummary(lastRow.deployment, lastRow.username) : null,
            current: currentRow ? toSummary(currentRow.deployment, currentRow.username) : null,
            containers: containers.get(composeProject) ?? [],
            alerts: alerts.get(env.id) ?? [],
            lastBackup: backupSummary(lastBackups.get(env.id)),
          }
        }),
    }))
    return { projects: result, dockerError }
  })

  /** Consommation des conteneurs en marche de tous les environnements Vercio. */
  app.get('/overview/usage', viewer, async (_request, reply): Promise<ContainerUsage[]> => {
    let all: Map<string, ContainerView[]>
    try {
      all = await host.composeContainerViews()
    } catch {
      return reply.code(502).send({ error: 'Docker injoignable' })
    }
    const managed = await vercioComposeProjects()
    const running = [...all]
      .filter(([project]) => managed.has(project))
      .flatMap(([, list]) => list.filter((container) => container.state === 'running'))
    const history = stats.history(running.map((container) => container.id))
    return running.map((container) => {
      const samples = (history.get(container.id) ?? []).slice(-USAGE_HISTORY)
      const latest = samples.at(-1)
      return {
        id: container.id,
        cpuPercent: latest?.cpuPercent ?? null,
        memoryBytes: latest?.memoryBytes ?? 0,
        memoryLimitBytes: latest?.memoryLimitBytes ?? 0,
        cpuHistory: samples.map((sample) => sample.cpuPercent ?? 0),
        memoryHistory: samples.map((sample) => sample.memoryBytes),
      }
    })
  })
}

function backupSummary(
  row: { status: string; startedAt: Date; finishedAt: Date | null } | undefined,
): BackupSummary | null {
  if (!row) return null
  return {
    status: row.status as BackupSummary['status'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}
