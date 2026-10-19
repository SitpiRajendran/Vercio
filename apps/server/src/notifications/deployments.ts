import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm'
import type { DeploymentSummary, NotificationEvent, NotificationSeverity } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSources, deployments, environments, projects, users } from '../db/schema.js'
import { buildMessage, type NotificationMessage } from './message.js'

type DeploymentRow = typeof deployments.$inferSelect
type Versions = DeploymentSummary['versions']

/** Fin d'une demande de déploiement, retour automatique compris. */
export interface DeploymentOutcome {
  deployment: DeploymentRow
  /** Déploiement de retour automatique lancé après l'échec. */
  rollback: DeploymentRow | null
  /** L'échec a eu lieu au démarrage des conteneurs (l'environnement a pu changer). */
  afterStart: boolean
  /** Vercio a redémarré pendant le déploiement. */
  interrupted?: boolean
}

function duration(row: DeploymentRow): string {
  if (!row.startedAt || !row.finishedAt) return ''
  const seconds = Math.max(
    0,
    Math.round((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000),
  )
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

function versionText(versions: Versions, names: Map<string, string>): string {
  return Object.entries(versions)
    .map(([id, version]) => `${names.get(id) ?? 'source'} ${version.tag}`)
    .join(', ')
}

/**
 * Message unique d'une demande de déploiement : réussite, échec, échec suivi d'un retour réussi
 * ou raté. Le déploiement de retour automatique n'a jamais de message à son nom.
 */
export async function deploymentMessage(
  db: Database,
  link: (path: string) => string,
  outcome: DeploymentOutcome,
): Promise<NotificationMessage | null> {
  const { deployment, rollback } = outcome
  const [scope] = await db
    .select({ project: projects, environment: environments })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environments.id, deployment.environmentId))
    .limit(1)
  if (!scope) return null
  const { project, environment } = scope

  const [previous] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.environmentId, deployment.environmentId),
        eq(deployments.status, 'succeeded'),
        ne(deployments.id, deployment.id),
        lt(deployments.createdAt, deployment.createdAt),
      ),
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1)

  const versions = deployment.versions as Versions
  const before = (previous?.versions ?? {}) as Versions
  const sourceIds = [...new Set([...Object.keys(versions), ...Object.keys(before)])]
  const names = new Map(
    sourceIds.length
      ? (
          await db
            .select({ id: appSources.id, name: appSources.name })
            .from(appSources)
            .where(inArray(appSources.id, sourceIds))
        ).map((row) => [row.id, row.name])
      : [],
  )
  const versionFacts = Object.entries(versions).map(([id, version]) => {
    const old = before[id]?.tag
    return {
      label: names.get(id) ?? 'Version',
      value: old && old !== version.tag ? `${old} → ${version.tag}` : version.tag,
    }
  })

  let author = 'Vercio'
  if (deployment.userId) {
    const [user] = await db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, deployment.userId))
      .limit(1)
    author = user?.displayName || user?.username || author
  }
  const trigger =
    deployment.trigger === 'webhook'
      ? 'Webhook (nouvelle image)'
      : deployment.trigger === 'rollback'
        ? `Retour manuel par ${author}`
        : author

  let event: NotificationEvent
  let severity: NotificationSeverity
  let title: string
  let summary: string
  let details: string | null = deployment.error
  const where = `${project.name} / ${environment.name}`
  if (deployment.status === 'succeeded') {
    event = 'deployment.succeeded'
    severity = 'success'
    title = `${deployment.trigger === 'rollback' ? 'Retour effectué' : 'Déploiement réussi'} · ${where}`
    summary = versionText(versions, names)
      ? `En ligne : ${versionText(versions, names)}`
      : 'Nouvelle version en ligne.'
    details = null
  } else if (rollback?.status === 'succeeded') {
    event = 'deployment.rolled_back'
    severity = 'warning'
    title = `Échec du déploiement, version précédente rétablie · ${where}`
    const restored = versionText(rollback.versions as Versions, names)
    summary = `Retour automatique réussi${restored ? ` : ${restored}` : ''}.`
  } else if (rollback) {
    event = 'deployment.rollback_failed'
    severity = 'critical'
    title = `Échec du déploiement et du retour automatique · ${where}`
    summary = 'L’environnement est probablement hors service : une intervention est nécessaire.'
    details = [deployment.error, rollback.error && `Retour automatique : ${rollback.error}`]
      .filter(Boolean)
      .join('\n\n')
  } else {
    event = 'deployment.failed'
    severity = 'critical'
    title = `Échec du déploiement · ${where}`
    const running = versionText(before, names)
    summary = outcome.interrupted
      ? 'Vercio a redémarré pendant le déploiement : l’état de l’environnement est incertain.'
      : outcome.afterStart
        ? 'Aucune version saine précédente pour un retour automatique : l’environnement est peut-être hors service.'
        : `L’environnement n’a pas été modifié${running ? ` : il tourne toujours sur ${running}` : ''}.`
  }

  return buildMessage({
    event,
    severity,
    title,
    summary,
    facts: [
      ...versionFacts,
      { label: 'Déclencheur', value: trigger },
      { label: 'Durée', value: duration(deployment) },
    ],
    details,
    url: link(`/projets/${project.slug}/deploiements/${deployment.id}`),
    linkLabel: 'Voir le journal',
    project: { id: project.id, slug: project.slug, name: project.name },
    environment: { id: environment.id, slug: environment.slug, name: environment.name },
    incident: null,
    data: {
      deploymentId: deployment.id,
      rollbackDeploymentId: rollback?.id ?? null,
      trigger: deployment.trigger,
      status: deployment.status,
      versions,
      previousVersions: before,
    },
  })
}
