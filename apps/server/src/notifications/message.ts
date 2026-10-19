import type { NotificationEvent, NotificationSeverity } from '@vercio/shared'

/**
 * Message structuré, commun à tous les canaux. Les valeurs sont nettoyées à la construction
 * (caractères de contrôle et de direction retirés, longueur bornée) ; chaque canal les échappe
 * ensuite à sa façon (HTML pour l'email, TextRun pour Teams, JSON pour le webhook).
 */
export interface NotificationMessage {
  event: NotificationEvent
  severity: NotificationSeverity
  /** « Échec du déploiement · boutique / production » */
  title: string
  /** Ligne d'état : « Retour automatique à v1.4.2 réussi ». */
  summary: string
  facts: { label: string; value: string }[]
  /** Erreur ou détail, déjà masqué. */
  details: string | null
  url: string | null
  linkLabel: string | null
  project: { id: string; slug: string; name: string } | null
  environment: { id: string; slug: string; name: string } | null
  incident: { id: string; status: 'open' | 'resolved' } | null
  /** Données propres à l'évènement, transmises telles quelles par le webhook sortant. */
  data: Record<string, unknown>
  occurredAt: string
}

/** Caractères de contrôle et de direction (RTL override…) qui maquillent un texte. */
const CONTROL = new RegExp(
  // eslint-disable-next-line no-control-regex -- on retire justement ces caractères
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g',
)

/** Nettoie une valeur dynamique : une seule ligne (sauf `multiline`), longueur bornée. */
export function clean(value: unknown, max = 120, { multiline = false } = {}): string {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
  if (!multiline) text = text.replace(/[\n\t]+/g, ' ')
  text = text.trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export const LIMITS = {
  title: 160,
  summary: 400,
  factLabel: 40,
  factValue: 200,
  details: 1500,
  facts: 10,
} as const

/** Construit un message en nettoyant toutes les valeurs affichées. */
export function buildMessage(
  input: Omit<NotificationMessage, 'occurredAt' | 'details' | 'url' | 'linkLabel' | 'data'> & {
    details?: string | null
    url?: string | null
    linkLabel?: string | null
    data?: Record<string, unknown>
    occurredAt?: Date
  },
): NotificationMessage {
  return {
    event: input.event,
    severity: input.severity,
    title: clean(input.title, LIMITS.title),
    summary: clean(input.summary, LIMITS.summary),
    facts: input.facts
      .filter((fact) => fact.value !== '')
      .slice(0, LIMITS.facts)
      .map((fact) => ({
        label: clean(fact.label, LIMITS.factLabel),
        value: clean(fact.value, LIMITS.factValue),
      })),
    details: input.details ? clean(input.details, LIMITS.details, { multiline: true }) : null,
    url: input.url ?? null,
    linkLabel: input.linkLabel ? clean(input.linkLabel, 60) : null,
    project: input.project
      ? {
          id: input.project.id,
          slug: input.project.slug,
          name: clean(input.project.name, 80),
        }
      : null,
    environment: input.environment
      ? {
          id: input.environment.id,
          slug: input.environment.slug,
          name: clean(input.environment.name, 80),
        }
      : null,
    incident: input.incident,
    data: input.data ?? {},
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  }
}

/** « boutique / production » */
export function scopeLabel(message: Pick<NotificationMessage, 'project' | 'environment'>): string {
  return [message.project?.name, message.environment?.name].filter(Boolean).join(' / ')
}

const SEVERITY_ORDER: NotificationSeverity[] = ['success', 'info', 'warning', 'critical']

export function maxSeverity(list: NotificationSeverity[]): NotificationSeverity {
  return list.reduce<NotificationSeverity>(
    (max, item) => (SEVERITY_ORDER.indexOf(item) > SEVERITY_ORDER.indexOf(max) ? item : max),
    'success',
  )
}

/** Plusieurs messages envoyés ensemble (alertes d'un environnement, limite de débit atteinte). */
export interface NotificationDigest {
  title: string
  severity: NotificationSeverity
  items: NotificationMessage[]
  url: string | null
}

/** Récapitulatif de plusieurs messages en attente d'un même canal. */
export function digestOf(items: NotificationMessage[], homeUrl: string): NotificationDigest {
  const environments = new Set(items.map((item) => item.environment?.id ?? ''))
  const first = items[0]!
  const sameScope = environments.size === 1 && first.environment
  return {
    title: sameScope
      ? `${items.length} alertes · ${scopeLabel(first)}`
      : `${items.length} notifications Vercio`,
    severity: maxSeverity(items.map((item) => item.severity)),
    items,
    url: sameScope ? first.url : homeUrl,
  }
}
