import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

// --- Énumérations -----------------------------------------------------------

export const authProvider = pgEnum('auth_provider', ['local', 'oidc'])
export const hostType = pgEnum('host_type', ['local', 'agent'])
export const gitProviderType = pgEnum('git_provider_type', ['gitlab', 'github'])
export const registryType = pgEnum('registry_type', ['gitlab', 'ghcr', 'oci'])
export const projectType = pgEnum('project_type', ['compose', 'single'])
export const composeSource = pgEnum('compose_source', ['inline', 'git'])
export const versionMode = pgEnum('version_mode', ['tracking', 'locked'])
export const versionSource = pgEnum('version_source', ['git_tags', 'commits'])
export const deployStrategy = pgEnum('deploy_strategy', ['recreate', 'blue-green'])
export const deploymentStatus = pgEnum('deployment_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
  'interrupted',
])
export const deploymentTrigger = pgEnum('deployment_trigger', [
  'user',
  'webhook',
  'rollback',
  'auto_rollback',
])
export const notificationType = pgEnum('notification_type', ['email', 'teams', 'webhook'])
export const notificationDeliveryStatus = pgEnum('notification_delivery_status', [
  'pending',
  'sending',
  'sent',
  'failed',
  'suppressed',
])

// --- Utilisateurs et sessions -------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    provider: authProvider('provider').notNull(),
    /** Identifiant chez le fournisseur OIDC (`sub`), ou nom d'utilisateur local. */
    subject: text('subject').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    passwordHash: text('password_hash'),
    totpSecretEnc: text('totp_secret_enc'),
    /** Dernier pas TOTP accepté : empêche de rejouer un code déjà utilisé. */
    totpLastStep: integer('totp_last_step'),
    /** Mot de passe temporaire (création, réinitialisation) : à changer à la prochaine connexion. */
    passwordChangeRequired: boolean('password_change_required').notNull().default(false),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    disabled: boolean('disabled').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_provider_subject_idx').on(t.provider, t.subject)],
)

export const sessions = pgTable(
  'sessions',
  {
    /** Empreinte SHA-256 du jeton de session (le jeton lui-même n'est jamais stocké). */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Session SSO : `sid` Keycloak (déconnexion back-channel) et ID token chiffré (déconnexion). */
    oidcSid: text('oidc_sid'),
    idTokenEnc: text('id_token_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    index('sessions_oidc_sid_idx').on(t.oidcSid),
  ],
)

// --- Infrastructure -------------------------------------------------------------

export const hosts = pgTable('hosts', {
  id: id(),
  name: text('name').notNull().unique(),
  type: hostType('type').notNull().default('local'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const gitProviders = pgTable('git_providers', {
  id: id(),
  name: text('name').notNull().unique(),
  type: gitProviderType('type').notNull(),
  apiUrl: text('api_url').notNull(),
  webUrl: text('web_url').notNull(),
  tokenEnc: text('token_enc').notNull(),
  caCertificate: text('ca_certificate'),
  /** Résultat du dernier test de connexion (ConnectionCheck). */
  lastCheck: jsonb('last_check'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const registries = pgTable('registries', {
  id: id(),
  name: text('name').notNull().unique(),
  type: registryType('type').notNull(),
  url: text('url').notNull(),
  username: text('username'),
  passwordEnc: text('password_enc'),
  insecure: boolean('insecure').notNull().default(false),
  caCertificate: text('ca_certificate'),
  gitProviderId: uuid('git_provider_id').references(() => gitProviders.id, {
    onDelete: 'set null',
  }),
  lastCheck: jsonb('last_check'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// --- Projets ------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  type: projectType('type').notNull().default('compose'),
  composeSource: composeSource('compose_source').notNull().default('inline'),
  composeInline: text('compose_inline'),
  /** Source applicative dont le dépôt contient le fichier Compose (si `compose_source = git`). */
  composeAppSourceId: uuid('compose_app_source_id'),
  composePath: text('compose_path').default('docker-compose.yml'),
  /** Apparence : icône et couleur proposées par l'interface, ou petite image (data URL). */
  icon: text('icon'),
  color: text('color'),
  logo: text('logo'),
  /** Adresse publique du site, pour l'ouvrir depuis Vercio. */
  url: text('url'),
  /** Services mis à jour sans coupure (blue-green avec relais). */
  zeroDowntimeServices: jsonb('zero_downtime_services').$type<string[]>().notNull().default([]),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Dépôt Git dont la CI construit une ou plusieurs images du projet. */
export const appSources = pgTable(
  'app_sources',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    gitProviderId: uuid('git_provider_id')
      .notNull()
      .references(() => gitProviders.id),
    /** Identifiant du dépôt chez le fournisseur (`groupe/projet` ou id numérique GitLab). */
    repository: text('repository').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    tagPattern: text('tag_pattern').notNull().default('^v\\d+\\.\\d+(\\.\\d+)?$'),
    latestTagName: text('latest_tag_name').notNull().default('latest'),
    /** Modèle du tag du dernier build (`{branch}`) ; null : `latest` / `<branche>-latest`. */
    latestTagTemplate: text('latest_tag_template'),
    /** Versions proposées : tags Git (`tagPattern`) ou derniers commits de la branche. */
    versionSource: versionSource('version_source').notNull().default('git_tags'),
    /** Tag d'image d'un commit (`{sha:8}`, `sha-{sha:7}`…), si `versionSource = commits`. */
    commitTagTemplate: text('commit_tag_template').notNull().default('{sha:8}'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('app_sources_project_name_idx').on(t.projectId, t.name)],
)

export const trackedServices = pgTable(
  'tracked_services',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    appSourceId: uuid('app_source_id')
      .notNull()
      .references(() => appSources.id, { onDelete: 'cascade' }),
    registryId: uuid('registry_id')
      .notNull()
      .references(() => registries.id),
    serviceName: text('service_name').notNull(),
    imageRepository: text('image_repository').notNull(),
  },
  (t) => [uniqueIndex('tracked_services_project_service_idx').on(t.projectId, t.serviceName)],
)

// --- Environnements -----------------------------------------------------------------

export const environments = pgTable(
  'environments',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    strategy: deployStrategy('strategy').notNull().default('recreate'),
    healthcheckTimeoutSeconds: integer('healthcheck_timeout_seconds').notNull().default(120),
    /** Politique de redémarrage des services qui n'en fixent pas dans le fichier Compose. */
    restartPolicy: text('restart_policy').notNull().default('unless-stopped'),
    /** Projet Compose lancé hors de Vercio, arrêté au premier déploiement et supprimé s'il réussit. */
    migratingFrom: text('migrating_from'),
    /** Volume du fichier Compose → volume Docker existant réutilisé (projet repris). */
    volumeMap: jsonb('volume_map').notNull().default({}),
    /** Liste d'IP / CIDR autorisées pour les webhooks (vide = liste globale). */
    webhookIpAllowlist: text('webhook_ip_allowlist')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('environments_project_slug_idx').on(t.projectId, t.slug)],
)

/** Version choisie pour une source applicative dans un environnement. */
export const environmentSources = pgTable(
  'environment_sources',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    appSourceId: uuid('app_source_id')
      .notNull()
      .references(() => appSources.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    /** `latest` (canal mobile de la branche) ou un tag de version précis. */
    ref: text('ref').notNull().default('latest'),
    mode: versionMode('mode').notNull().default('tracking'),
    /** Jeton de l'URL du webhook : empreinte pour la recherche, valeur chiffrée pour l'affichage. */
    webhookTokenHash: text('webhook_token_hash').unique(),
    webhookTokenEnc: text('webhook_token_enc'),
    /** Secret des webhooks natifs (en-tête X-Gitlab-Token, signature GitHub), chiffré. */
    webhookSecretEnc: text('webhook_secret_enc'),
    /** Webhook créé par Vercio chez le fournisseur (identifiant chez GitLab / GitHub). */
    webhookRemoteId: text('webhook_remote_id'),
    webhookInstalledAt: timestamp('webhook_installed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.appSourceId] })],
)

export const envVariables = pgTable(
  'env_variables',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Null : variable partagée par tous les environnements du projet. */
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    valueEnc: text('value_enc').notNull(),
    secret: boolean('secret').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('env_variables_scope_key_unique')
      .on(t.projectId, t.environmentId, t.key)
      .nullsNotDistinct(),
  ],
)

/**
 * Réseau Docker `vercio-shared-<name>` : un service d'un environnement y est joignable par
 * son alias DNS depuis les environnements abonnés (base de données mutualisée…).
 */
export const sharedNetworks = pgTable('shared_networks', {
  id: id(),
  name: text('name').notNull().unique(),
  exposedByEnvironmentId: uuid('exposed_by_environment_id')
    .notNull()
    .references(() => environments.id, { onDelete: 'cascade' }),
  /** Service du fichier Compose de l'environnement exposé. */
  service: text('service').notNull(),
  alias: text('alias').notNull(),
  description: text('description'),
  createdAt: createdAt(),
})

export const environmentNetworks = pgTable(
  'environment_networks',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    sharedNetworkId: uuid('shared_network_id')
      .notNull()
      .references(() => sharedNetworks.id, { onDelete: 'cascade' }),
    /** Services rattachés au réseau ; null : tous les services de l'environnement. */
    services: jsonb('services').$type<string[] | null>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.sharedNetworkId] })],
)

// --- Déploiements -------------------------------------------------------------------

export const deployments = pgTable(
  'deployments',
  {
    id: id(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    trigger: deploymentTrigger('trigger').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Par source applicative : `{ [appSourceId]: { branch, tag } }`. */
    versions: jsonb('versions').notNull().default({}),
    /** Par service suivi : référence complète épinglée `{ [serviceName]: "hôte/chemin@sha256:…" }`. */
    digests: jsonb('digests').notNull().default({}),
    /** Fichier Compose utilisé (tel que lu dans le dépôt ou saisi). */
    composeRendered: text('compose_rendered'),
    /** Surcharge générée par Vercio : images épinglées par digest, labels. */
    composeOverride: text('compose_override'),
    status: deploymentStatus('status').notNull().default('queued'),
    error: text('error'),
    rollbackOfId: uuid('rollback_of_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('deployments_environment_created_idx').on(t.environmentId, t.createdAt)],
)

export const deploymentLogs = pgTable(
  'deployment_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    stream: text('stream').notNull().default('stdout'),
    line: text('line').notNull(),
  },
  (t) => [index('deployment_logs_deployment_idx').on(t.deploymentId, t.id)],
)

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    appSourceId: uuid('app_source_id').references(() => appSources.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    ip: text('ip'),
    payload: jsonb('payload'),
    result: text('result').notNull(),
    reason: text('reason'),
    deploymentId: uuid('deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_events_environment_idx').on(t.environmentId, t.createdAt)],
)

/** Paramètres globaux modifiables depuis l'interface (clé → valeur JSON). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})

// --- Notifications et audit -------------------------------------------------------

export const notificationChannels = pgTable('notification_channels', {
  id: id(),
  name: text('name').notNull().unique(),
  type: notificationType('type').notNull(),
  /** Destinataires, URL et secret de signature : chiffrés (l'URL Teams contient une signature). */
  configEnc: text('config_enc').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** Cases cochées (NotificationGroup). */
  groups: text('groups')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** `all` : tous les projets ; `selected` : ceux de notification_channel_projects. */
  projectScope: text('project_scope').notNull().default('all'),
  /** Vide : tous les environnements. */
  environmentSlugs: text('environment_slugs')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Dernier envoi ou test (ConnectionCheck). */
  lastResult: jsonb('last_result'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  failingSince: timestamp('failing_since', { withTimezone: true }),
  /** La panne du canal a déjà été signalée sur les autres canaux. */
  failureNotified: boolean('failure_notified').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const notificationChannelProjects = pgTable(
  'notification_channel_projects',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.projectId] })],
)

/**
 * File d'envoi et journal des notifications : une ligne par canal et par évènement. Elle survit
 * aux redémarrages de Vercio ; les réessais sont planifiés par `next_attempt_at`.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    /** Message structuré, valeurs déjà nettoyées et masquées ; rendu selon le canal à l'envoi. */
    message: jsonb('message').notNull(),
    /** Messages d'un même groupe (alertes d'un environnement) envoyés ensemble. */
    groupKey: text('group_key'),
    /** Anti-spam : un seul envoi par clé et par fenêtre, les suivants sont comptés. */
    dedupeKey: text('dedupe_key'),
    status: notificationDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Envoyé dans le récapitulatif d'un autre message. */
    mergedIntoId: uuid('merged_into_id'),
    suppressedCount: integer('suppressed_count').notNull().default(0),
    error: text('error'),
    /** Code de réponse SMTP ou statut HTTP du dernier essai. */
    statusCode: integer('status_code'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('notification_deliveries_queue_idx').on(t.status, t.nextAttemptAt),
    index('notification_deliveries_channel_idx').on(t.channelId, t.createdAt),
    index('notification_deliveries_dedupe_idx').on(t.channelId, t.dedupeKey, t.createdAt),
  ],
)

/**
 * Incidents suivis (service arrêté, unhealthy, disque plein) : on notifie à l'ouverture et à la
 * résolution, jamais à chaque mesure.
 */
export const notificationIncidents = pgTable(
  'notification_incidents',
  {
    id: id(),
    /** `container:<projet Compose>/<service>/<numéro>` ou `disk:<chemin>`. */
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    data: jsonb('data').notNull().default({}),
    occurrences: integer('occurrences').notNull().default(1),
    /** L'ouverture a été notifiée : la résolution le sera aussi. */
    notified: boolean('notified').notNull().default(false),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('notification_incidents_key_idx').on(t.key, t.kind, t.openedAt),
    uniqueIndex('notification_incidents_open_idx')
      .on(t.key, t.kind)
      .where(sql`resolved_at is null`),
  ],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    success: boolean('success').notNull(),
    details: jsonb('details'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_at_idx').on(t.at)],
)

// --- Sauvegardes ----------------------------------------------------------------------

export const backupDestinationType = pgEnum('backup_destination_type', ['local', 's3'])

export const backupDestinations = pgTable('backup_destinations', {
  id: id(),
  name: text('name').notNull().unique(),
  type: backupDestinationType('type').notNull(),
  /** Réglages non secrets (chemin, bucket, région…). */
  config: jsonb('config').notNull(),
  /** Identifiants S3, chiffrés. */
  credentialsEnc: text('credentials_enc'),
  /** Phrase de chiffrement des sauvegardes, chiffrée ; null : sauvegardes en clair. */
  passphraseEnc: text('passphrase_enc'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const backupPlans = pgTable('backup_plans', {
  environmentId: uuid('environment_id')
    .primaryKey()
    .references(() => environments.id, { onDelete: 'cascade' }),
  destinationId: uuid('destination_id')
    .notNull()
    .references(() => backupDestinations.id, { onDelete: 'restrict' }),
  enabled: boolean('enabled').notNull().default(true),
  schedule: jsonb('schedule').notNull(),
  keep: integer('keep').notNull().default(7),
  selection: jsonb('selection').$type<Record<string, boolean>>().notNull().default({}),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  updatedAt: updatedAt(),
})

export const backups = pgTable(
  'backups',
  {
    id: id(),
    /** Null : sauvegarde de Vercio lui-même (sa base de données). */
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    destinationId: uuid('destination_id').references(() => backupDestinations.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull(),
    trigger: text('trigger').notNull(),
    /** Dossier de la sauvegarde dans la destination. */
    location: text('location').notNull(),
    encrypted: boolean('encrypted').notNull(),
    items: jsonb('items').notNull().default([]),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    logs: jsonb('logs').$type<string[]>().notNull().default([]),
    error: text('error'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backups_env_idx').on(t.environmentId, t.startedAt)],
)

export const backupRestores = pgTable(
  'backup_restores',
  {
    id: id(),
    backupId: uuid('backup_id')
      .notNull()
      .references(() => backups.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    items: jsonb('items').$type<string[]>().notNull(),
    logs: jsonb('logs').$type<string[]>().notNull().default([]),
    error: text('error'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backup_restores_backup_idx').on(t.backupId, t.startedAt)],
)
