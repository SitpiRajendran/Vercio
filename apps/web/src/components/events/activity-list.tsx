import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  DatabaseBackup,
  History,
  GitCommitHorizontal,
  Play,
  Rocket,
  RotateCw,
  Square,
  Undo2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { ActivityItem } from '@vercio/shared'
import { DeploymentStatusBadge } from '@/components/projects/deployment-status'
import { Badge } from '@/components/ui/badge'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WEBHOOK_RESULTS } from '@/pages/projects/webhooks-tab'

const BACKUP_BADGES = {
  running: { label: 'En cours', className: 'text-warning' },
  succeeded: { label: 'Réussie', className: 'text-success' },
  partial: { label: 'Incomplète', className: 'text-warning' },
  failed: { label: 'Échec', className: 'text-destructive' },
} as const

const SOURCE_LABELS: Record<string, string> = {
  generic: 'CI',
  gitlab: 'GitLab',
  github: 'GitHub',
}

const ACTION_LABELS = {
  start: { label: 'démarré', icon: Play },
  stop: { label: 'arrêté', icon: Square },
  restart: { label: 'redémarré', icon: RotateCw },
} as const

const INCIDENT_LABELS: Record<string, string> = {
  down: 's’est arrêté',
  restarting: 'redémarre en boucle',
  unhealthy: 'ne répond plus (healthcheck)',
  resources: 'consomme beaucoup',
}

interface Line {
  icon: ReactNode
  /** Ton de l'icône : erreur, avertissement… */
  tone?: string
  title: ReactNode
  detail: string | null
  badge: ReactNode
}

function describe(item: ActivityItem, compact: boolean): Line {
  const projectLink = (children: ReactNode, onglet?: string) => (
    <Link
      to="/projets/$slug"
      params={{ slug: item.project.slug }}
      search={{ env: item.environment.slug, ...(onglet ? { onglet } : {}) }}
      className="font-medium hover:underline"
    >
      {children}
    </Link>
  )
  switch (item.kind) {
    case 'deployment': {
      const { deployment } = item
      const version = deployment.tags.join(', ')
      const rollback = deployment.trigger === 'rollback' || deployment.trigger === 'auto_rollback'
      const verb =
        deployment.trigger === 'auto_rollback'
          ? 'Retour automatique'
          : deployment.trigger === 'rollback'
            ? 'Retour'
            : 'Déploiement'
      const by =
        deployment.trigger === 'webhook'
          ? 'après un push'
          : deployment.trigger === 'auto_rollback'
            ? 'après un échec'
            : deployment.username
              ? `par ${deployment.username}`
              : null
      return {
        icon: rollback ? <Undo2 /> : <Rocket />,
        title: (
          <Link
            to="/projets/$slug/deploiements/$deploymentId"
            params={{ slug: item.project.slug, deploymentId: deployment.id }}
            className="font-medium hover:underline"
          >
            {verb}
            {version ? (rollback ? ` à ${version}` : ` de ${version}`) : ''}
          </Link>
        ),
        detail: [by, !compact ? deployment.error : null].filter(Boolean).join(' · ') || null,
        badge: <DeploymentStatusBadge status={deployment.status} />,
      }
    }
    case 'webhook': {
      const { webhook } = item
      const result = WEBHOOK_RESULTS[webhook.result] ?? WEBHOOK_RESULTS.ignored
      return {
        icon: <GitCommitHorizontal />,
        title: projectLink(`Push ${SOURCE_LABELS[webhook.source] ?? webhook.source}`, 'webhooks'),
        detail: [webhook.ip, !compact ? webhook.reason : null].filter(Boolean).join(' · ') || null,
        badge: (
          <Badge variant="outline" className={cn(result.className)}>
            {result.label}
          </Badge>
        ),
      }
    }
    case 'action': {
      const { action } = item
      const info = ACTION_LABELS[action.name]
      const Icon = info.icon
      return {
        icon: <Icon />,
        title: projectLink(`${action.service ?? 'Tous les conteneurs'} ${info.label}`),
        detail: action.username ? `par ${action.username}` : null,
        badge: action.success ? null : (
          <Badge variant="outline" className="text-destructive">
            Échec
          </Badge>
        ),
      }
    }
    case 'incident': {
      const { incident } = item
      return {
        icon: <AlertTriangle />,
        tone: incident.resolvedAt ? 'text-muted-foreground' : 'text-destructive',
        title: projectLink(
          `${incident.service ?? 'Un service'} ${INCIDENT_LABELS[incident.type] ?? incident.type}`,
          'logs',
        ),
        detail:
          [incident.detail, incident.occurrences > 1 ? `${incident.occurrences} fois` : null]
            .filter(Boolean)
            .join(' · ') || null,
        badge: incident.resolvedAt ? (
          <Badge variant="outline" className="text-success">
            Rétabli
          </Badge>
        ) : (
          <Badge variant="outline" className="text-destructive">
            En cours
          </Badge>
        ),
      }
    }
    case 'backup': {
      const { backup } = item
      const restore = backup.operation === 'restore'
      const badge = BACKUP_BADGES[backup.status]
      return {
        icon: restore ? <History /> : <DatabaseBackup />,
        tone: backup.status === 'failed' ? 'text-destructive' : undefined,
        title: projectLink(restore ? 'Restauration d’une sauvegarde' : 'Sauvegarde', 'sauvegardes'),
        detail:
          [
            backup.username ? `par ${backup.username}` : restore ? null : 'planifiée',
            !compact ? backup.error : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
        badge: (
          <Badge variant="outline" className={badge.className}>
            {badge.label}
          </Badge>
        ),
      }
    }
  }
}

/** Fil d'activité : déploiements, retours, pushs, actions sur les conteneurs, pannes, sauvegardes. */
export function ActivityList({
  items,
  compact = false,
  showProject = true,
}: {
  items: ActivityItem[]
  compact?: boolean
  /** Masqué sur la page d'un projet. */
  showProject?: boolean
}) {
  return (
    <ul className="divide-y">
      {items.map((item) => {
        const line = describe(item, compact)
        return (
          <li key={`${item.kind}-${item.id}`} className="flex gap-3 py-2.5">
            <span className={cn('text-muted-foreground mt-0.5 [&_svg]:size-4', line.tone)}>
              {line.icon}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {line.title}
                {showProject && (
                  <span className="text-muted-foreground">
                    {item.project.name} · {item.environment.name}
                  </span>
                )}
              </p>
              <p className="text-muted-foreground truncate text-xs" title={formatDateTime(item.at)}>
                {formatRelative(item.at)}
                {line.detail ? ` · ${line.detail}` : ''}
              </p>
            </div>
            {line.badge && <div className="shrink-0">{line.badge}</div>}
          </li>
        )
      })}
    </ul>
  )
}
