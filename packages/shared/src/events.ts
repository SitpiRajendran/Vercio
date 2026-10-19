import { z } from 'zod'
import type { DeploymentStatus } from './domain.js'
import type { WebhookResult } from './operations.js'

// --- Activité (déploiements et webhooks, tous projets) -------------------------------

export const activityQuerySchema = z.object({
  /** Slug du projet ; absent : tous les projets. */
  project: z.string().max(100).optional(),
  kind: z.enum(['deployment', 'webhook', 'action', 'incident', 'backup']).optional(),
  /** Pagination : éléments antérieurs à cette date (ISO 8601). */
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ActivityQuery = z.input<typeof activityQuerySchema>

interface ActivityBase {
  id: string
  at: string
  project: { slug: string; name: string }
  environment: { slug: string; name: string }
}

export type ActivityItem =
  | (ActivityBase & {
      kind: 'deployment'
      deployment: {
        id: string
        status: DeploymentStatus
        trigger: 'user' | 'webhook' | 'rollback' | 'auto_rollback'
        username: string | null
        tags: string[]
        error: string | null
      }
    })
  | (ActivityBase & {
      kind: 'webhook'
      webhook: {
        result: WebhookResult
        reason: string | null
        source: string
        ip: string | null
        deploymentId: string | null
      }
    })
  | (ActivityBase & {
      /** Action manuelle sur les conteneurs (journal d'audit). */
      kind: 'action'
      action: {
        name: 'start' | 'stop' | 'restart'
        /** Service visé ; null : tout l'environnement. */
        service: string | null
        username: string | null
        success: boolean
      }
    })
  | (ActivityBase & {
      /** Panne détectée par la surveillance des conteneurs. */
      kind: 'incident'
      incident: {
        type: string
        service: string | null
        /** Explication lisible : « arrêté par manque de mémoire (OOM) »… */
        detail: string | null
        /** Nombre de retours de la panne (service instable). */
        occurrences: number
        resolvedAt: string | null
      }
    })
  | (ActivityBase & {
      /** Restauration, sauvegarde manuelle ou sauvegarde en échec (les réussites planifiées sont tues). */
      kind: 'backup'
      backup: {
        operation: 'backup' | 'restore'
        backupId: string
        status: 'running' | 'succeeded' | 'partial' | 'failed'
        username: string | null
        error: string | null
      }
    })

// --- Journal d'audit ------------------------------------------------------------------

export const auditQuerySchema = z.object({
  /** Identifiant (exact) de l'utilisateur. */
  user: z.string().trim().max(200).optional(),
  /** Début de l'action : `settings`, `user.`, `deployment.create`… */
  action: z.string().trim().max(100).optional(),
  success: z.enum(['true', 'false']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Pagination : entrées plus anciennes que cet identifiant. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type AuditQuery = z.input<typeof auditQuerySchema>

export interface AuditEntryView {
  id: number
  at: string
  username: string | null
  action: string
  target: string | null
  ip: string | null
  success: boolean
  details: Record<string, unknown> | null
}

/** Familles d'actions proposées dans le filtre, avec leur libellé. */
export const AUDIT_ACTION_GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'auth.', label: 'Connexions et mots de passe' },
  { prefix: 'user.', label: 'Comptes utilisateurs' },
  { prefix: 'project.', label: 'Projets' },
  { prefix: 'environment.', label: 'Environnements' },
  { prefix: 'deployment.', label: 'Déploiements' },
  { prefix: 'variables.', label: 'Variables' },
  { prefix: 'container.', label: 'Conteneurs et terminal' },
  { prefix: 'network.', label: 'Réseaux partagés' },
  { prefix: 'webhook', label: 'Webhooks' },
  { prefix: 'settings.', label: 'Paramètres' },
  { prefix: 'cleanup.', label: 'Nettoyage' },
  { prefix: 'backup.', label: 'Sauvegardes' },
]
