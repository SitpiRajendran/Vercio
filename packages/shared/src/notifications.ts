import { z } from 'zod'
import { slugSchema } from './naming.js'
import type { ConnectionCheck } from './settings.js'

// --- Évènements ------------------------------------------------------------------------

/** Identifiants techniques : repris tels quels dans le payload du webhook sortant. */
export const NOTIFICATION_EVENTS = [
  'deployment.succeeded',
  'deployment.failed',
  'deployment.rolled_back',
  'deployment.rollback_failed',
  'webhook.rejected',
  'webhook.ignored',
  'webhook.failed',
  'container.down',
  'container.restarting',
  'container.unhealthy',
  'container.recovered',
  'container.resources',
  'disk.low',
  'disk.critical',
  'disk.recovered',
  'backup.failed',
  'notification.channel_failing',
  'notification.channel_recovered',
  'test',
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical'

/**
 * Abonnements proposés à l'admin : chaque case couvre plusieurs évènements techniques
 * (le rétablissement part avec l'alerte à laquelle il répond).
 */
export const NOTIFICATION_GROUPS = {
  'deployment.succeeded': {
    section: 'Déploiements',
    label: 'Réussi',
    events: ['deployment.succeeded'],
  },
  'deployment.failed': {
    section: 'Déploiements',
    label: 'Échoué, avec ou sans retour automatique',
    events: [
      'deployment.failed',
      'deployment.rolled_back',
      'deployment.rollback_failed',
      'webhook.failed',
    ],
  },
  'webhook.rejected': {
    section: 'Webhooks',
    label: 'Appel refusé (adresse, signature ou corps invalide)',
    events: ['webhook.rejected'],
  },
  'webhook.ignored': {
    section: 'Webhooks',
    label: 'Nouveau build ignoré : environnement verrouillé',
    events: ['webhook.ignored'],
  },
  'container.failed': {
    section: 'Conteneurs',
    label: 'Service en échec : arrêté, redémarre en boucle ou unhealthy',
    events: [
      'container.down',
      'container.restarting',
      'container.unhealthy',
      'container.recovered',
    ],
  },
  'container.resources': {
    section: 'Conteneurs',
    label: 'Processeur ou mémoire saturés de façon répétée ou prolongée',
    events: ['container.resources'],
  },
  'disk.low': {
    section: 'Hôte',
    label: 'Espace disque faible',
    events: ['disk.low', 'disk.critical', 'disk.recovered'],
  },
  'backup.failed': {
    section: 'Sauvegardes',
    label: 'Sauvegarde échouée ou incomplète',
    events: ['backup.failed'],
  },
} as const satisfies Record<
  string,
  { section: string; label: string; events: readonly NotificationEvent[] }
>
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS
export const NOTIFICATION_GROUP_KEYS = Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]

/** Cochés à la création d'un canal : tout sauf les succès et les builds ignorés. */
export const DEFAULT_NOTIFICATION_GROUPS: NotificationGroup[] = [
  'deployment.failed',
  'webhook.rejected',
  'container.failed',
  'container.resources',
  'disk.low',
  'backup.failed',
]

/** Case qui couvre un évènement (null : évènement toujours envoyé, ex. canal en échec). */
export function notificationGroupOf(event: NotificationEvent): NotificationGroup | null {
  for (const key of NOTIFICATION_GROUP_KEYS) {
    if ((NOTIFICATION_GROUPS[key].events as readonly string[]).includes(event)) return key
  }
  return null
}

/** Évènements de l'hôte : livrés quel que soit le filtre de projets du canal. */
export function isHostEvent(event: NotificationEvent): boolean {
  return event.startsWith('disk.') || event.startsWith('notification.')
}

// --- Canaux ----------------------------------------------------------------------------

export const notificationChannelTypeSchema = z.enum(['email', 'teams', 'webhook'])
export type NotificationChannelType = z.infer<typeof notificationChannelTypeSchema>

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannelType, string> = {
  email: 'Email',
  teams: 'Microsoft Teams',
  webhook: 'Webhook sortant',
}

/** Adresse seule : jamais de liste, de nom affiché ni de retour à la ligne (injection d'en-têtes). */
export const emailAddressSchema = z
  .string()
  .trim()
  .max(254)
  .refine((value) => !/[\s,;<>"]/.test(value), { message: 'Une adresse par ligne, sans nom' })
  .pipe(z.email({ message: 'Adresse email invalide' }))

const channelName = z.string().trim().min(1, { message: 'Nom requis' }).max(60)

const channelBase = {
  name: channelName,
  enabled: z.boolean().default(true),
  groups: z
    .array(z.enum(NOTIFICATION_GROUP_KEYS as [NotificationGroup, ...NotificationGroup[]]))
    .min(1, { message: 'Cochez au moins un évènement' })
    .transform((groups) => [...new Set(groups)]),
  /** `selected` sans projet : le canal ne reçoit que les alertes de l'hôte. */
  projectScope: z.enum(['all', 'selected']).default('all'),
  projectIds: z.array(z.uuid()).max(200).default([]),
  /** Vide : tous les environnements. Sinon, slugs d'environnement (production, staging…). */
  environmentSlugs: z
    .array(slugSchema)
    .max(50)
    .default([])
    .transform((slugs) => [...new Set(slugs)]),
}

/** URL d'un webhook (Teams ou sortant) : vide lors d'une modification = URL enregistrée conservée. */
const optionalUrl = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .transform((value) => value || undefined)
  .refine((value) => !value || z.url().safeParse(value).success, { message: 'URL invalide' })

export const notificationChannelInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...channelBase,
      type: z.literal('email'),
      recipients: z
        .array(emailAddressSchema)
        .max(50, { message: '50 destinataires au plus' })
        .default([])
        .transform((list) => [...new Set(list.map((address) => address.toLowerCase()))]),
      /** Ajoute au moment de l'envoi l'adresse des administrateurs actifs. */
      allAdmins: z.boolean().default(false),
    })
    .refine((value) => value.recipients.length > 0 || value.allAdmins, {
      message: 'Ajoutez au moins un destinataire',
      path: ['recipients'],
    }),
  z.object({
    ...channelBase,
    type: z.literal('teams'),
    url: optionalUrl.refine((value) => !value || value.startsWith('https://'), {
      message: 'L’URL du workflow Teams commence par https://',
    }),
  }),
  z.object({
    ...channelBase,
    type: z.literal('webhook'),
    url: optionalUrl.refine((value) => !value || /^https?:\/\//.test(value), {
      message: 'URL http(s) attendue',
    }),
    /** HTTP non chiffré : seulement pour un récepteur interne, sur choix explicite. */
    allowHttp: z.boolean().default(false),
  }),
])
export type NotificationChannelInput = z.input<typeof notificationChannelInputSchema>
export type NotificationChannelData = z.output<typeof notificationChannelInputSchema>

export interface NotificationChannelView {
  id: string
  name: string
  type: NotificationChannelType
  enabled: boolean
  groups: NotificationGroup[]
  projectScope: 'all' | 'selected'
  projects: { id: string; name: string; slug: string }[]
  environmentSlugs: string[]
  /** Résumé de la destination, sans secret. */
  target: string
  email: { recipients: string[]; allAdmins: boolean } | null
  /** Hôte de l'URL Teams seulement : l'URL complète contient une signature (`sig=`). */
  teams: { urlHint: string } | null
  webhook: { url: string; hasSecret: boolean; allowHttp: boolean } | null
  lastResult: ConnectionCheck | null
  consecutiveFailures: number
  failingSince: string | null
  createdAt: string
}

/** Réponse à la création d'un webhook sortant ou au renouvellement de son secret. */
export interface NotificationChannelSecret {
  channel: NotificationChannelView
  /** Secret de signature, affiché une seule fois. */
  secret: string | null
}

export type NotificationDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'suppressed'

export interface NotificationDeliveryView {
  id: string
  channelId: string
  channelName: string
  event: NotificationEvent
  severity: NotificationSeverity
  title: string
  status: NotificationDeliveryStatus
  attempts: number
  /** Message regroupé dans un envoi récapitulatif. */
  merged: boolean
  suppressedCount: number
  error: string | null
  statusCode: number | null
  createdAt: string
  sentAt: string | null
  nextAttemptAt: string | null
}

// --- Serveur SMTP ----------------------------------------------------------------------

export const smtpSecuritySchema = z.enum(['tls', 'starttls', 'none'])
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>

export const SMTP_SECURITY_LABELS: Record<SmtpSecurity, string> = {
  starttls: 'STARTTLS obligatoire (port 587)',
  tls: 'TLS implicite (port 465)',
  none: 'Aucun chiffrement (relais local)',
}
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  starttls: 587,
  tls: 465,
  none: 25,
}

/** Hôte local : seul cas où un mot de passe peut circuler sans chiffrement. */
export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || /^127\.\d+\.\d+\.\d+$/.test(value)
}

export const smtpSettingsInputSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1, { message: 'Hôte requis' })
      .max(253)
      .regex(/^[A-Za-z0-9.:[\]-]+$/, { message: 'Nom d’hôte ou adresse IP attendu' }),
    port: z.coerce.number().int().min(1).max(65535),
    security: smtpSecuritySchema.default('starttls'),
    username: z
      .string()
      .trim()
      .max(256)
      .optional()
      .transform((value) => value || undefined),
    /** Vide lors d'une modification : le mot de passe enregistré est conservé. */
    password: z
      .string()
      .max(1024)
      .optional()
      .transform((value) => value || undefined),
    from: emailAddressSchema,
    fromName: z
      .string()
      .trim()
      .max(80)
      .regex(/^[^\r\n<>"]*$/, { message: 'Caractères interdits dans le nom' })
      .default('Vercio'),
    caCertificate: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || undefined)
      .refine((value) => !value || value.includes('-----BEGIN CERTIFICATE-----'), {
        message: 'Certificat PEM attendu',
      }),
  })
  .refine(
    (value) => !(value.username && value.security === 'none' && !isLoopbackHost(value.host)),
    {
      message: 'Un mot de passe ne peut pas circuler sans chiffrement : choisissez STARTTLS ou TLS',
      path: ['security'],
    },
  )
export type SmtpSettingsInput = z.input<typeof smtpSettingsInputSchema>
export type SmtpSettingsData = z.output<typeof smtpSettingsInputSchema>

export interface SmtpSettingsView {
  configured: boolean
  host: string
  port: number
  security: SmtpSecurity
  username: string | null
  hasPassword: boolean
  from: string
  fromName: string
  caCertificate: string | null
  lastCheck: ConnectionCheck | null
}

export const smtpTestSchema = z.object({
  settings: z.unknown(),
  /** Adresse qui reçoit l'email de test ; absente : test de connexion seulement. */
  to: emailAddressSchema.optional(),
})

// --- Hôte ------------------------------------------------------------------------------

export interface DiskUsageView {
  path: string
  /** Libellé du disque mesuré (« données de Vercio », « images et conteneurs Docker »). */
  label: string
  totalBytes: number
  freeBytes: number
  freeInodesRatio: number | null
  level: 'ok' | 'low' | 'critical'
  lowThresholdBytes: number
  measuredAt: string
}

// --- Saturation CPU et mémoire ---------------------------------------------------------

/** Réglages de la surveillance du processeur et de la mémoire des services. */
export const resourceAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Processeur : % d'un cœur (200 = deux cœurs pleins). */
  cpuPercent: z.number().int().min(10).max(6400),
  /** Mémoire : % de la limite du conteneur (ou de la mémoire de l'hôte). */
  memoryPercent: z.number().int().min(10).max(100),
  /** Durée au-dessus du seuil avant qu'un épisode commence (et en dessous pour qu'il finisse). */
  sustainMinutes: z.number().int().min(1).max(60),
  /** Épisodes sur 24 h à partir desquels la notification part. */
  frequentEpisodes: z.number().int().min(1).max(50),
  /** Durée d'un épisode à partir de laquelle la notification part. */
  longMinutes: z.number().int().min(1).max(1440),
})
export type ResourceAlertSettings = z.infer<typeof resourceAlertSettingsSchema>

export const DEFAULT_RESOURCE_ALERT_SETTINGS: ResourceAlertSettings = {
  enabled: true,
  cpuPercent: 90,
  memoryPercent: 90,
  sustainMinutes: 2,
  frequentEpisodes: 3,
  longMinutes: 15,
}
