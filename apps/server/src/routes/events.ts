import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, gte, ilike, inArray, lt, or, type SQL } from 'drizzle-orm'
import {
  activityQuerySchema,
  auditQuerySchema,
  type ActivityItem,
  type AuditEntryView,
  type DeploymentSummary,
  type WebhookResult,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import {
  auditLogs,
  backupRestores,
  backups,
  deployments,
  environments,
  notificationIncidents,
  projects,
  users,
  webhookEvents,
} from '../db/schema.js'
import { describeExit } from '../notifications/containers.js'
import { parseInput } from './helpers.js'

type AuditRow = typeof auditLogs.$inferSelect

/** Lignes exportées au plus : au-delà, filtrer par date. */
const EXPORT_LIMIT = 20_000

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function toAuditView(row: AuditRow): AuditEntryView {
  return {
    id: row.id,
    at: row.at.toISOString(),
    username: row.username,
    action: row.action,
    target: row.target,
    ip: row.ip,
    success: row.success,
    details: (row.details as Record<string, unknown> | null) ?? null,
  }
}

/** Champ CSV : séparateur `;` (Excel en français), guillemets doublés, pas de formule. */
function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  // Une cellule qui commence par = + - @ serait interprétée comme une formule par le tableur.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Activité des projets et journal d'audit. */
export const eventRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  /** Déploiements et appels de webhook, du plus récent au plus ancien, tous projets. */
  app.get(
    '/events/activity',
    { preHandler: app.requireRole('vercio-viewer') },
    async (request, reply) => {
      const query = parseInput(activityQuerySchema, request.query, reply)
      if (!query) return
      const before = query.before ? new Date(query.before) : null
      const projectFilter = query.project ? eq(projects.slug, query.project) : undefined
      const items: ActivityItem[] = []

      if (!query.kind || query.kind === 'deployment') {
        const rows = await db
          .select({
            deployment: deployments,
            username: users.username,
            project: projects,
            environment: environments,
          })
          .from(deployments)
          .innerJoin(environments, eq(environments.id, deployments.environmentId))
          .innerJoin(projects, eq(projects.id, environments.projectId))
          .leftJoin(users, eq(users.id, deployments.userId))
          .where(and(projectFilter, before ? lt(deployments.createdAt, before) : undefined))
          .orderBy(desc(deployments.createdAt))
          .limit(query.limit)
        for (const row of rows) {
          const versions = row.deployment.versions as DeploymentSummary['versions']
          items.push({
            kind: 'deployment',
            id: row.deployment.id,
            at: row.deployment.createdAt.toISOString(),
            project: { slug: row.project.slug, name: row.project.name },
            environment: { slug: row.environment.slug, name: row.environment.name },
            deployment: {
              id: row.deployment.id,
              status: row.deployment.status,
              trigger: row.deployment.trigger,
              username: row.username,
              tags: [...new Set(Object.values(versions).map((version) => version.tag))],
              error: row.deployment.error,
            },
          })
        }
      }

      if (!query.kind || query.kind === 'webhook') {
        const rows = await db
          .select({ event: webhookEvents, project: projects, environment: environments })
          .from(webhookEvents)
          .innerJoin(environments, eq(environments.id, webhookEvents.environmentId))
          .innerJoin(projects, eq(projects.id, environments.projectId))
          .where(and(projectFilter, before ? lt(webhookEvents.createdAt, before) : undefined))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(query.limit)
        for (const row of rows) {
          items.push({
            kind: 'webhook',
            id: row.event.id,
            at: row.event.createdAt.toISOString(),
            project: { slug: row.project.slug, name: row.project.name },
            environment: { slug: row.environment.slug, name: row.environment.name },
            webhook: {
              result: row.event.result as WebhookResult,
              reason: row.event.reason,
              source: row.event.source,
              ip: row.event.ip,
              deploymentId: row.event.deploymentId,
            },
          })
        }
      }

      if (
        !query.kind ||
        query.kind === 'action' ||
        query.kind === 'incident' ||
        query.kind === 'backup'
      ) {
        // Projets et environnements par slug (cibles du journal d'audit, projets Compose).
        const envRows = await db
          .select({ project: projects, environment: environments })
          .from(environments)
          .innerJoin(projects, eq(projects.id, environments.projectId))
          .where(projectFilter)
        const byTarget = new Map(
          envRows.map((row) => [`${row.project.slug}/${row.environment.slug}`, row]),
        )
        const byId = new Map(envRows.map((row) => [row.environment.id, row]))
        const refs = (row: (typeof envRows)[number]) => ({
          project: { slug: row.project.slug, name: row.project.name },
          environment: { slug: row.environment.slug, name: row.environment.name },
        })

        if (!query.kind || query.kind === 'action') {
          const rows = await db
            .select()
            .from(auditLogs)
            .where(
              and(
                inArray(auditLogs.action, [
                  'container.start',
                  'container.stop',
                  'container.restart',
                ]),
                query.project
                  ? ilike(auditLogs.target, `${escapeLike(query.project)}/%`)
                  : undefined,
                before ? lt(auditLogs.at, before) : undefined,
              ),
            )
            .orderBy(desc(auditLogs.at))
            .limit(query.limit)
          for (const row of rows) {
            const [projectSlug, envSlug, service] = (row.target ?? '').split('/')
            const target = byTarget.get(`${projectSlug}/${envSlug}`)
            if (!target) continue
            items.push({
              kind: 'action',
              id: `audit-${row.id}`,
              at: row.at.toISOString(),
              ...refs(target),
              action: {
                name: row.action.slice('container.'.length) as 'start' | 'stop' | 'restart',
                service: service || null,
                username: row.username,
                success: row.success,
              },
            })
          }
        }

        if ((!query.kind || query.kind === 'backup') && byId.size) {
          const envIds = [...byId.keys()]
          const backupRows = await db
            .select()
            .from(backups)
            .where(
              and(
                inArray(backups.environmentId, envIds),
                or(inArray(backups.status, ['failed', 'partial']), eq(backups.trigger, 'manual')),
                before ? lt(backups.startedAt, before) : undefined,
              ),
            )
            .orderBy(desc(backups.startedAt))
            .limit(query.limit)
          const restoreRows = await db
            .select({ restore: backupRestores, environmentId: backups.environmentId })
            .from(backupRestores)
            .innerJoin(backups, eq(backups.id, backupRestores.backupId))
            .where(
              and(
                inArray(backups.environmentId, envIds),
                before ? lt(backupRestores.startedAt, before) : undefined,
              ),
            )
            .orderBy(desc(backupRestores.startedAt))
            .limit(query.limit)
          for (const row of backupRows) {
            items.push({
              kind: 'backup',
              id: `backup-${row.id}`,
              at: row.startedAt.toISOString(),
              ...refs(byId.get(row.environmentId!)!),
              backup: {
                operation: 'backup',
                backupId: row.id,
                status: row.status as 'succeeded',
                username: row.username,
                error: row.error,
              },
            })
          }
          for (const { restore, environmentId } of restoreRows) {
            items.push({
              kind: 'backup',
              id: `restore-${restore.id}`,
              at: restore.startedAt.toISOString(),
              ...refs(byId.get(environmentId!)!),
              backup: {
                operation: 'restore',
                backupId: restore.backupId,
                status: restore.status as 'succeeded',
                username: restore.username,
                error: restore.error,
              },
            })
          }
        }

        if ((!query.kind || query.kind === 'incident') && byId.size) {
          const rows = await db
            .select()
            .from(notificationIncidents)
            .where(
              and(
                inArray(notificationIncidents.environmentId, [...byId.keys()]),
                before ? lt(notificationIncidents.openedAt, before) : undefined,
              ),
            )
            .orderBy(desc(notificationIncidents.openedAt))
            .limit(query.limit)
          for (const row of rows) {
            const target = byId.get(row.environmentId!)
            if (!target) continue
            const data = (row.data ?? {}) as {
              service?: string
              exitCode?: number | null
              oomKilled?: boolean
              detail?: string
            }
            items.push({
              kind: 'incident',
              id: row.id,
              at: row.openedAt.toISOString(),
              ...refs(target),
              incident: {
                type: row.kind,
                service: data.service ?? null,
                detail:
                  data.detail ??
                  (row.kind === 'down' && data.exitCode !== undefined
                    ? describeExit({
                        exitCode: data.exitCode ?? null,
                        oomKilled: data.oomKilled ?? false,
                      })
                    : null),
                occurrences: row.occurrences,
                resolvedAt: row.resolvedAt?.toISOString() ?? null,
              },
            })
          }
        }
      }

      return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, query.limit)
    },
  )

  const admin = { preHandler: app.requireRole('vercio-admin') }

  function auditFilter(query: ReturnType<typeof auditQuerySchema.parse>): SQL | undefined {
    const conditions: (SQL | undefined)[] = [
      query.user ? eq(auditLogs.username, query.user) : undefined,
      query.action ? ilike(auditLogs.action, `${escapeLike(query.action)}%`) : undefined,
      query.success ? eq(auditLogs.success, query.success === 'true') : undefined,
      query.from ? gte(auditLogs.at, new Date(`${query.from}T00:00:00`)) : undefined,
      // Date de fin incluse : jusqu'au lendemain minuit.
      query.to
        ? lt(auditLogs.at, new Date(new Date(`${query.to}T00:00:00`).getTime() + 86_400_000))
        : undefined,
    ]
    return and(...conditions)
  }

  /** Journal d'audit : immuable, filtrable, paginé par identifiant décroissant. */
  app.get('/audit', admin, async (request, reply) => {
    const query = parseInput(auditQuerySchema, request.query, reply)
    if (!query) return
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(auditFilter(query), query.before ? lt(auditLogs.id, query.before) : undefined))
      .orderBy(desc(auditLogs.id))
      .limit(query.limit)
    return rows.map(toAuditView)
  })

  /** Utilisateurs présents dans le journal (filtre de l'interface). */
  app.get('/audit/users', admin, async () => {
    const rows = await db
      .selectDistinct({ username: auditLogs.username })
      .from(auditLogs)
      .orderBy(auditLogs.username)
    return rows.map((row) => row.username).filter((name): name is string => Boolean(name))
  })

  /** Export CSV (UTF-8 avec BOM, `;`) des entrées filtrées. */
  app.get('/audit/export.csv', admin, async (request, reply) => {
    const query = parseInput(auditQuerySchema, request.query, reply)
    if (!query) return
    const rows = await db
      .select()
      .from(auditLogs)
      .where(auditFilter(query))
      .orderBy(desc(auditLogs.id))
      .limit(EXPORT_LIMIT)
    const header = ['Date', 'Utilisateur', 'Action', 'Cible', 'Adresse IP', 'Résultat', 'Détails']
    const lines = rows.map((row) =>
      [
        row.at.toISOString(),
        row.username,
        row.action,
        row.target,
        row.ip,
        row.success ? 'succès' : 'échec',
        row.details ? JSON.stringify(row.details) : '',
      ]
        .map(csvField)
        .join(';'),
    )
    const date = new Date().toISOString().slice(0, 10)
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="vercio-audit-${date}.csv"`)
    return `\uFEFF${[header.join(';'), ...lines].join('\r\n')}\r\n`
  })
}
