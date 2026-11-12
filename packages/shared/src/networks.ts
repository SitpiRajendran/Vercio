import { z } from 'zod'
import { variableKeySchema } from './projects.js'

/** Nom d'un réseau partagé : `postgres-prod` donne le réseau Docker `vercio-shared-postgres-prod`. */
export const sharedNetworkNameSchema = z
  .string()
  .trim()
  .min(2, { message: '2 caractères au moins' })
  .max(40, { message: '40 caractères au plus' })
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Minuscules, chiffres et tirets, sans tiret au début ni à la fin',
  })

/** Alias DNS du service exposé, joignable depuis les environnements abonnés. */
export const sharedNetworkAliasSchema = z
  .string()
  .trim()
  .min(1, { message: 'Alias requis' })
  .max(63, { message: '63 caractères au plus' })
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Minuscules, chiffres et tirets, sans tiret au début ni à la fin',
  })

export function sharedNetworkDockerName(name: string): string {
  return `vercio-shared-${name}`
}

export const sharedNetworkInputSchema = z.object({
  name: sharedNetworkNameSchema,
  environmentId: z.uuid({ message: 'Environnement requis' }),
  service: z.string().trim().min(1, { message: 'Service requis' }).max(100),
  alias: sharedNetworkAliasSchema,
  description: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
})
export type SharedNetworkInput = z.input<typeof sharedNetworkInputSchema>

/** Modification : le nom (donc le réseau Docker) et l'environnement exposé restent. */
export const sharedNetworkUpdateSchema = sharedNetworkInputSchema.pick({
  service: true,
  alias: true,
  description: true,
})
export type SharedNetworkUpdate = z.input<typeof sharedNetworkUpdateSchema>

/** Abonnements d'un environnement (remplacent les précédents). */
export const environmentNetworksSchema = z.object({
  subscriptions: z
    .array(
      z.object({
        networkId: z.uuid(),
        /** Services rattachés ; null : tous. */
        services: z.array(z.string().min(1).max(100)).min(1).nullable(),
      }),
    )
    .max(20),
})
export type EnvironmentNetworksInput = z.input<typeof environmentNetworksSchema>

/**
 * Liaison d'un environnement à un service d'un autre projet (« Connecter à un projet ») : le
 * réseau partagé est créé au besoin, l'abonnement ajouté, et les conteneurs en marche branchés.
 */
/** Type de service joint, d'après son image : il décide du port, de l'adresse et des accès. */
export type LinkKind = 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'service'

export const LINK_KINDS: Record<
  LinkKind,
  { label: string; port: number | null; variable: string; dedicated: boolean }
> = {
  postgres: { label: 'PostgreSQL', port: 5432, variable: 'DATABASE_URL', dedicated: true },
  mysql: { label: 'MySQL', port: 3306, variable: 'DATABASE_URL', dedicated: true },
  mariadb: { label: 'MariaDB', port: 3306, variable: 'DATABASE_URL', dedicated: true },
  mongo: { label: 'MongoDB', port: 27017, variable: 'MONGODB_URI', dedicated: true },
  redis: { label: 'Redis', port: 6379, variable: 'REDIS_URL', dedicated: false },
  service: { label: 'Service', port: null, variable: 'SERVICE_URL', dedicated: false },
}

/** Base et utilisateur dédiés : `[a-z][a-z0-9_]*`, 32 caractères au plus. */
export const linkDatabaseNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, {
  message: 'Lettres minuscules, chiffres et _ (32 caractères au plus, une lettre d’abord)',
})

/** `planny-v2` → `planny_v2` : nom de base et d'utilisateur proposé pour un projet. */
export function linkDatabaseName(projectSlug: string): string {
  const name = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (/^[a-z]/.test(name) ? name : `app_${name}`).slice(0, 32).replace(/_+$/, '') || 'app'
}

/**
 * Adresse à donner à l'application. Avec des identifiants dédiés : URL complète ; sinon
 * l'adresse seule, à compléter dans les variables si le service demande un mot de passe.
 */
export function linkUrl(
  kind: LinkKind,
  host: string,
  port: number | null,
  credentials?: { user: string; password: string; database: string } | null,
): string {
  const address = port ? `${host}:${port}` : host
  const auth = credentials
    ? `${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@`
    : ''
  const database = credentials ? `/${credentials.database}` : ''
  switch (kind) {
    case 'postgres':
      return `postgresql://${auth}${address}${database}`
    case 'mysql':
    case 'mariadb':
      return `mysql://${auth}${address}${database}`
    case 'mongo':
      return `mongodb://${auth}${address}${database}${credentials ? `?authSource=${credentials.database}` : ''}`
    case 'redis':
      return `redis://${address}`
    case 'service':
      return `http://${address}`
  }
}

/** Service qu'un environnement peut joindre : celui d'un autre projet, déjà déployé. */
export interface LinkTarget extends EnvironmentRef {
  service: string
  image: string | null
  kind: LinkKind
  /** Port d'écoute : celui du type, ou le premier port déclaré dans le fichier Compose. */
  port: number | null
  running: boolean
  /** Déjà relié à cet environnement : sous ce nom. */
  linkedAs: string | null
}

/**
 * « Connecter un service » : un réseau propre à cette liaison (les applications reliées au même
 * service ne se voient pas entre elles), au besoin une base et un utilisateur dédiés, la
 * variable de connexion enregistrée, et un redéploiement pour la prendre en compte.
 */
export const environmentLinkSchema = z.object({
  targetEnvironmentId: z.uuid({ message: 'Projet requis' }),
  service: z.string().trim().min(1, { message: 'Service requis' }).max(100),
  /** Nom sous lequel le service est joint depuis cet environnement. */
  alias: sharedNetworkAliasSchema,
  /** Services de cet environnement reliés ; null : tous. */
  services: z.array(z.string().min(1).max(100)).min(1).nullable(),
  /** Bases : créer une base et un utilisateur dédiés (`dedicated`), ou l'adresse seule. */
  access: z.enum(['dedicated', 'none']).default('none'),
  /** Nom de la base et de l'utilisateur dédiés. */
  database: linkDatabaseNameSchema.optional(),
  /** Variable de connexion enregistrée (secrète) dans cet environnement ; null : aucune. */
  variable: variableKeySchema.nullable().default(null),
  /** Port joint, si le type ne le donne pas (service HTTP). */
  port: z.number().int().min(1).max(65535).nullable().default(null),
  /** Redéployer cet environnement ensuite (la variable n'est lue qu'au démarrage). */
  redeploy: z.boolean().default(false),
})
export type EnvironmentLinkInput = z.input<typeof environmentLinkSchema>

export interface EnvironmentLinkResult {
  network: SharedNetworkView
  /** Conteneurs en marche branchés tout de suite ; sinon, au prochain déploiement. */
  applied: boolean
  /** Raison quand le branchement immédiat n'a pas pu se faire. */
  detail: string | null
  /** Base et utilisateur dédiés créés (ou mis à jour). */
  database: { name: string; user: string } | null
  /** Variable enregistrée (sa valeur n'est jamais renvoyée). */
  variable: string | null
  deploymentId: string | null
}

export interface EnvironmentRef {
  projectId: string
  projectSlug: string
  projectName: string
  environmentId: string
  environmentSlug: string
  environmentName: string
}

export interface SharedNetworkView {
  id: string
  name: string
  /** Réseau Docker. */
  dockerName: string
  alias: string
  description: string | null
  exposedBy: EnvironmentRef & { service: string }
  subscribers: (EnvironmentRef & { services: string[] | null })[]
  /** État Docker : null si Docker est injoignable. */
  docker: {
    exists: boolean
    /** Conteneurs attachés, avec leur projet Compose. */
    containers: { name: string; project: string | null }[]
  } | null
  createdAt: string
}
