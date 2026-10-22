import { z } from 'zod'

// --- Destinations ----------------------------------------------------------------------

export const backupDestinationTypeSchema = z.enum(['local', 's3'])
export type BackupDestinationType = z.infer<typeof backupDestinationTypeSchema>

export const BACKUP_DESTINATION_LABELS: Record<BackupDestinationType, string> = {
  local: 'Dossier du serveur',
  s3: 'Stockage S3 (AWS, Scaleway, OVH, MinIO…)',
}

/** Phrase de chiffrement : sans elle, impossible de relire les sauvegardes chiffrées. */
export const backupPassphraseSchema = z
  .string()
  .min(12, { message: '12 caractères au moins' })
  .max(200)

const destinationName = z.string().trim().min(1, { message: 'Nom requis' }).max(60)

export const localDestinationConfigSchema = z.object({
  path: z
    .string()
    .trim()
    .regex(/^\/[^\0]*$/, { message: 'Chemin absolu requis (ex. /var/lib/vercio/sauvegardes)' })
    .refine((path) => !path.split('/').includes('..'), { message: 'Chemin invalide' })
    .max(500),
})

export const s3DestinationConfigSchema = z.object({
  /** Vide : AWS (adresse déduite de la région). */
  endpoint: z
    .union([z.literal(''), z.url({ protocol: /^https?$/, message: 'Adresse http(s) invalide' })])
    .default(''),
  region: z.string().trim().min(1).max(60).default('us-east-1'),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { message: 'Nom de bucket invalide' }),
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]*$/, { message: 'Lettres, chiffres, « . _ - / » seulement' })
    .transform((prefix) => prefix.replace(/^\/+|\/+$/g, ''))
    .default(''),
  /** MinIO et la plupart des hébergeurs hors AWS. */
  pathStyle: z.boolean().default(false),
})

export const s3CredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1, { message: 'Clé d’accès requise' }).max(200),
  secretAccessKey: z.string().min(1, { message: 'Clé secrète requise' }).max(200),
})

/**
 * Création ou modification. En modification, `credentials` et `passphrase` absents gardent
 * les valeurs enregistrées ; `passphrase: null` désactive le chiffrement.
 */
export const backupDestinationInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    name: destinationName,
    config: localDestinationConfigSchema,
    passphrase: backupPassphraseSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('s3'),
    name: destinationName,
    config: s3DestinationConfigSchema,
    credentials: s3CredentialsSchema.optional(),
    passphrase: backupPassphraseSchema.nullable().optional(),
  }),
])
export type BackupDestinationInput = z.input<typeof backupDestinationInputSchema>

export type LocalDestinationConfig = z.infer<typeof localDestinationConfigSchema>
export type S3DestinationConfig = z.infer<typeof s3DestinationConfigSchema>

export interface BackupDestinationView {
  id: string
  name: string
  type: BackupDestinationType
  config: LocalDestinationConfig | S3DestinationConfig
  /** « s3://bucket/prefix (adresse) » ou le chemin. */
  location: string
  encrypted: boolean
  hasCredentials: boolean
  /** Environnements qui l'utilisent. */
  plans: number
  /**
   * Dossier : emplacement réel sur le serveur (le conteneur de Vercio voit les dossiers montés
   * sous un autre chemin) ; null s'il n'est pas monté, donc perdu à la recréation du conteneur.
   * Absent pour S3, ou quand Docker ne permet pas de le savoir.
   */
  hostPath?: string | null
  createdAt: string
}

// --- Plans ------------------------------------------------------------------------------

export const backupScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily'),
    /** Heure du serveur. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Heure au format HH:MM' }),
  }),
  z.object({ kind: z.literal('interval'), hours: z.number().int().min(1).max(168) }),
])
export type BackupSchedule = z.infer<typeof backupScheduleSchema>

export const backupPlanInputSchema = z.object({
  /** Désactivé : sauvegardes à la demande seulement. */
  enabled: z.boolean(),
  destinationId: z.uuid({ message: 'Choisissez une destination' }),
  schedule: backupScheduleSchema,
  keep: z.number().int().min(1).max(365),
  /**
   * Choix explicites (`volume:<nom>`, `database:<service>` → inclus ou non) ; sans choix,
   * l'élément suit `includedByDefault` : un nouveau volume est donc sauvegardé d'office.
   */
  selection: z
    .record(z.string().max(300), z.boolean())
    .refine((value) => Object.keys(value).length <= 200, { message: 'Trop d’éléments' })
    .default({}),
})
export type BackupPlanInput = z.input<typeof backupPlanInputSchema>

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { kind: 'daily', time: '03:00' }
export const DEFAULT_BACKUP_KEEP = 7

export interface BackupPlanView {
  enabled: boolean
  destination: { id: string; name: string; encrypted: boolean } | null
  schedule: BackupSchedule
  keep: number
  selection: Record<string, boolean>
  nextRunAt: string | null
}

export type BackupItemKind = 'volume' | 'database'
export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb' | 'mongo'

export const DATABASE_ENGINE_LABELS: Record<DatabaseEngine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mongo: 'MongoDB',
}

/** Ce qu'un environnement permet de sauvegarder. */
export interface BackupCandidate {
  key: string
  kind: BackupItemKind
  /** Nom du volume, ou service de la base. */
  name: string
  engine: DatabaseEngine | null
  /** Services qui utilisent le volume. */
  services: string[]
  /** Volume de données d'une base déjà exportée : écarté par défaut (copie à chaud incohérente). */
  coveredBy: string | null
  includedByDefault: boolean
}

/** Élément retenu : choix explicite, sinon le comportement par défaut. */
export function isBackupItemIncluded(
  candidate: Pick<BackupCandidate, 'key' | 'includedByDefault'>,
  selection: Record<string, boolean>,
): boolean {
  return selection[candidate.key] ?? candidate.includedByDefault
}

export interface BackupPlanPage {
  plan: BackupPlanView | null
  candidates: BackupCandidate[]
  /** Docker injoignable : candidats inconnus. */
  dockerError: string | null
}

// --- Historique -------------------------------------------------------------------------

export type BackupStatus = 'running' | 'succeeded' | 'partial' | 'failed'
export type BackupTrigger = 'manual' | 'schedule'

export interface BackupItem {
  key: string
  kind: BackupItemKind
  name: string
  engine: DatabaseEngine | null
  /** Fichier dans le dossier de la sauvegarde. */
  file: string | null
  sizeBytes: number
  status: 'ok' | 'failed'
  error: string | null
  /** Empreinte HMAC du fichier stocké : vérifiée avant toute restauration. */
  hmac?: string
  /** Base de Vercio : migrations appliquées au moment de la sauvegarde. */
  migrations?: number
}

export interface BackupView {
  id: string
  status: BackupStatus
  trigger: BackupTrigger
  destination: { id: string; name: string } | null
  location: string
  encrypted: boolean
  items: BackupItem[]
  sizeBytes: number
  username: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** Dernière restauration depuis cette sauvegarde. */
  lastRestore: BackupRestoreView | null
}

export interface BackupRestoreView {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  items: string[]
  username: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export const backupRestoreInputSchema = z.object({
  items: z.array(z.string().max(300)).min(1, { message: 'Choisissez au moins un élément' }),
  /** Nom de l'environnement, retapé pour confirmer. */
  confirm: z.string(),
})
export type BackupRestoreInput = z.infer<typeof backupRestoreInputSchema>

/** Dernière sauvegarde, affichée sur l'accueil. */
export interface BackupSummary {
  status: BackupStatus
  startedAt: string
  finishedAt: string | null
}

/** Onglet « Sauvegardes » d'un environnement. */
export interface BackupEnvironmentPage extends BackupPlanPage {
  backups: BackupView[]
}

export interface BackupDetail extends BackupView {
  logs: string[]
  /** Journal de la dernière restauration. */
  restoreLogs: string[]
}

/** Destination proposée dans le formulaire du plan. */
export interface BackupDestinationChoice {
  id: string
  name: string
  type: BackupDestinationType
  encrypted: boolean
}

// --- Sauvegarde de Vercio lui-même ------------------------------------------------------

/** Base de données de Vercio (projets, comptes, secrets chiffrés, historique). */
export const vercioBackupPlanInputSchema = backupPlanInputSchema.omit({ selection: true })
export type VercioBackupPlanInput = z.input<typeof vercioBackupPlanInputSchema>

export interface VercioBackupPage {
  plan: BackupPlanView | null
  backups: BackupView[]
  /** Restauration de Vercio en cours ou échouée (une réussite redémarre Vercio). */
  restore: VercioRestoreState | null
}

export interface VercioRestoreState {
  backupId: string
  status: 'running' | 'failed'
  error: string | null
  logs: string[]
  startedAt: string
}

/** Confirmation : retaper « vercio ». */
export const vercioRestoreInputSchema = z.object({
  confirm: z.literal('vercio', { message: 'Tapez « vercio » pour confirmer' }),
})
