import { z } from 'zod'
import { environmentMigrationSchema } from './imports.js'
import type { DeploymentStatus } from './domain.js'
import { slugSchema } from './naming.js'

// --- Données lues chez les fournisseurs Git ------------------------------------------

export interface RepositorySummary {
  /** Identifiant chez le fournisseur : `groupe/projet` (GitLab) ou `owner/repo` (GitHub). */
  fullName: string
  name: string
  defaultBranch: string | null
  webUrl: string
  private: boolean
}

export interface BranchSummary {
  name: string
  isDefault: boolean
}

/** Image trouvée dans le registry associé au dépôt (registry GitLab, GHCR). */
export interface RegistryImageSuggestion {
  /** Hôte du registry : registry.gitlab.com, ghcr.io… */
  host: string
  /** Chemin de l'image dans le registry : groupe/projet/front */
  path: string
}

// --- Fichiers YAML d'un dépôt --------------------------------------------------------

/** Noms de fichier Compose reconnus par Docker, dans son ordre de préférence. */
export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const

/** Fichier Compose standard à la racine du dépôt, s'il y en a un. */
export function defaultComposeFile(files: readonly string[]): string | null {
  return COMPOSE_FILE_NAMES.find((name) => files.includes(name)) ?? null
}

/**
 * Fichiers YAML d'un dépôt pouvant contenir un Compose : sans les dossiers de CI et de
 * dépendances ; ceux dont le nom évoque Compose d'abord, puis les moins profonds.
 */
export function composeCandidates(paths: readonly string[], limit = 200): string[] {
  const excludedDirectory = /(^|\/)(\.github|\.gitlab|node_modules|vendor|\.git)\//
  // Fichiers YAML courants qui ne sont jamais des fichiers Compose.
  const notCompose = /^(\..*|pnpm-lock\.yaml|pnpm-workspace\.yaml|mkdocs\.ya?ml|codecov\.ya?ml)$/i
  const name = (path: string) => path.split('/').at(-1) ?? path
  const looksCompose = (path: string) => /compose/i.test(name(path))
  return paths
    .filter(
      (path) =>
        /\.ya?ml$/i.test(path) && !excludedDirectory.test(path) && !notCompose.test(name(path)),
    )
    .sort(
      (a, b) =>
        Number(looksCompose(b)) - Number(looksCompose(a)) ||
        a.split('/').length - b.split('/').length ||
        a.localeCompare(b),
    )
    .slice(0, limit)
}

// --- Analyse d'un fichier Compose ---------------------------------------------------

export interface ComposeServiceInfo {
  name: string
  /** Image déclarée, sans modification (peut contenir des variables `${…}`). */
  image: string | null
  hasBuild: boolean
  ports: string[]
  /** Healthcheck déclaré dans le fichier Compose (celui de l'image n'est pas visible ici). */
  hasHealthcheck: boolean
  /** Politique `restart` fixée dans le fichier Compose : elle prime sur celle de l'environnement. */
  restart: string | null
  /** Réseaux déclarés par le service ; null : réseau `default` implicite. */
  networks: string[] | null
  /** `network_mode` (host, service:…) : le service ne peut pas rejoindre un réseau partagé. */
  networkMode: string | null
  /** Services démarrés avant celui-ci (`depends_on`). */
  dependsOn: string[]
  /** Variables utilisées par ce service : interpolées dans sa définition ou transmises par nom. */
  variables: string[]
  /** Le service lit un `env_file` : il reçoit toutes les variables. */
  envFile: boolean
  /** Mise à jour sans coupure possible (blue-green avec relais), sinon pourquoi. */
  zeroDowntime: { eligible: boolean; reason: string | null; warning: string | null }
}

export interface ComposeAnalysis {
  services: ComposeServiceInfo[]
  /**
   * Variables que le fichier utilise : interpolées (`${NOM}`) ou transmises telles quelles
   * (`environment: [NOM]`). Les autres variables de Vercio n'atteignent aucun conteneur.
   */
  variables?: string[]
  /** Un service lit un `env_file` : Vercio y écrit toutes les variables. */
  envFile?: boolean
  /** Erreur de syntaxe ou de structure : le fichier ne peut pas être utilisé tel quel. */
  error: string | null
  warnings: string[]
}

/** Découpe une référence d'image en hôte, chemin et tag (ou digest). */
export function parseImageReference(reference: string): {
  host: string | null
  path: string
  tag: string | null
} {
  let rest = reference
  let tag: string | null = null
  const at = rest.indexOf('@')
  if (at !== -1) {
    tag = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  const lastSlash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  if (colon > lastSlash) {
    tag ??= rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const firstSlash = rest.indexOf('/')
  const first = firstSlash === -1 ? '' : rest.slice(0, firstSlash)
  // Comme Docker : le premier segment est un hôte s'il contient un point, un port ou vaut localhost.
  if (first && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return { host: first, path: rest.slice(firstSlash + 1), tag }
  }
  return { host: null, path: rest, tag }
}

// --- Apparence d'un projet ----------------------------------------------------------------

/** Icônes proposées pour un projet (noms convertis en icônes par l'interface). */
export const PROJECT_ICONS = [
  'globe',
  'server',
  'database',
  'shopping-cart',
  'newspaper',
  'message-square',
  'mail',
  'chart',
  'shield',
  'cloud',
  'code',
  'box',
  'layers',
  'gamepad',
  'music',
  'image',
  'book',
  'users',
  'wallet',
  'bot',
] as const
export type ProjectIcon = (typeof PROJECT_ICONS)[number]

export const PROJECT_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'sky',
  'blue',
  'violet',
  'pink',
] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

/** Image du projet : petite image (PNG, JPEG, WebP) encodée, redimensionnée par l'interface. */
export const projectLogoSchema = z
  .string()
  .max(200_000, { message: 'Image trop lourde (150 Ko au plus)' })
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, {
    message: 'Image PNG, JPEG ou WebP attendue',
  })

/** Adresse publique du site (bouton « Ouvrir ») : http ou https seulement. */
export const projectUrlSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^https?:\/\/[^\s]+$/i, { message: 'Adresse http:// ou https:// attendue' })

export const projectAppearanceSchema = z.object({
  icon: z.enum(PROJECT_ICONS).nullable().optional(),
  color: z.enum(PROJECT_COLORS).nullable().optional(),
  logo: projectLogoSchema.nullable().optional(),
  url: projectUrlSchema.nullable().optional(),
})
export type ProjectAppearance = {
  icon: ProjectIcon | null
  color: ProjectColor | null
  logo: string | null
  /** Adresse publique du site. */
  url: string | null
}

// --- Saisie d'un projet ----------------------------------------------------------------

const sourceKey = z.string().min(1).max(40)

/** Convention de tags d'images d'un dépôt : comment Vercio retrouve les builds de la CI. */
export const tagConventionSchema = z.object({
  /** Modèle du tag du dernier build (`{branch}`) ; null : `latest` / `<branche>-latest`. */
  latestTagTemplate: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9_.{}-]+$/, {
      message: 'Lettres, chiffres, « . », « - », « _ » et {branch} uniquement',
    })
    .nullable()
    .default(null),
  versionSource: z.enum(['git_tags', 'commits']).default('git_tags'),
  /** Expression régulière des tags Git de version. */
  tagPattern: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) => {
        try {
          new RegExp(value)
          return true
        } catch {
          return false
        }
      },
      { message: 'Expression régulière invalide' },
    )
    .default('^v\\d+\\.\\d+(\\.\\d+)?$'),
  /** Tag d'image d'un commit : `{sha:8}`, `sha-{sha:7}`, `{sha}`… */
  commitTagTemplate: z
    .string()
    .trim()
    .max(128)
    .regex(/\{sha(:\d{1,2})?\}/, { message: 'Doit contenir {sha} ou {sha:8}' })
    .regex(/^[A-Za-z0-9_.{}:-]+$/, { message: 'Caractères non autorisés dans un tag' })
    .default('{sha:8}'),
})
export type TagConvention = z.output<typeof tagConventionSchema>

export const appSourceInputSchema = z.object({
  /** Clé locale au formulaire, pour relier services et environnements à cette source. */
  key: sourceKey,
  name: z.string().trim().min(1).max(60),
  gitProviderId: z.uuid(),
  repository: z.string().trim().min(1).max(255),
  defaultBranch: z.string().trim().min(1).max(255),
  ...tagConventionSchema.shape,
})

export const trackedServiceInputSchema = z.object({
  serviceName: z.string().min(1).max(100),
  sourceKey,
  registryId: z.uuid(),
  imageRepository: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/, {
      message: 'Chemin d’image invalide (ex. groupe/projet/front)',
    }),
})

export const composeInputSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('inline'), content: z.string().min(1).max(200_000) }),
  z.object({
    source: z.literal('git'),
    sourceKey,
    path: z.string().trim().min(1).max(255).default('docker-compose.yml'),
  }),
])

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, { message: 'Nom requis' }).max(80),
  slug: slugSchema,
  description: z.string().trim().max(500).optional(),
  type: z.enum(['compose', 'single']),
  compose: composeInputSchema,
  sources: z.array(appSourceInputSchema).max(10),
  trackedServices: z.array(trackedServiceInputSchema).max(50),
  ...projectAppearanceSchema.shape,
})
export type ProjectInput = z.input<typeof projectInputSchema>

/**
 * Version d'un environnement : `latest` désigne le dernier build de la branche choisie
 * (tag `latest` sur la branche par défaut, `<branche>-latest` ailleurs) ; sinon un tag précis.
 */
export const environmentSourceInputSchema = z.object({
  /** Clé de la source (création de projet) ou identifiant (environnement existant). */
  source: z.string().min(1),
  branch: z.string().trim().min(1).max(255),
  ref: z.string().trim().min(1).max(128).default('latest'),
  mode: z.enum(['tracking', 'locked']).default('tracking'),
})

/**
 * Redémarrage automatique des conteneurs (politique Docker), appliqué aux services qui ne fixent
 * pas le leur dans le fichier Compose.
 */
export const RESTART_POLICIES = ['unless-stopped', 'always', 'on-failure', 'no'] as const
export type RestartPolicy = (typeof RESTART_POLICIES)[number]
export const restartPolicySchema = z.enum(RESTART_POLICIES)
export const DEFAULT_RESTART_POLICY: RestartPolicy = 'unless-stopped'
export const RESTART_POLICY_LABELS: Record<RestartPolicy, { label: string; hint: string }> = {
  'unless-stopped': {
    label: 'Toujours, sauf arrêt manuel (unless-stopped)',
    hint: 'Relancé après un plantage et au redémarrage de Docker ou de la machine, sauf s’il a été arrêté volontairement.',
  },
  always: {
    label: 'Toujours (always)',
    hint: 'Comme unless-stopped, mais relancé aussi au redémarrage de Docker après un arrêt manuel.',
  },
  'on-failure': {
    label: 'Après un plantage seulement (on-failure)',
    hint: 'Relancé si le conteneur s’arrête en erreur ; pas au redémarrage de la machine.',
  },
  no: {
    label: 'Jamais (no)',
    hint: 'Comportement par défaut de Docker : un conteneur arrêté le reste.',
  },
}

export const environmentInputSchema = z.object({
  name: z.string().trim().min(1, { message: 'Nom requis' }).max(60),
  slug: slugSchema,
  sources: z.array(environmentSourceInputSchema),
  restartPolicy: restartPolicySchema.default(DEFAULT_RESTART_POLICY),
  /** Reprise d'un projet lancé hors de Vercio (assistant d'import). */
  migration: environmentMigrationSchema.optional(),
})
export type EnvironmentInput = z.input<typeof environmentInputSchema>

export const createProjectSchema = projectInputSchema.extend({
  environments: z.array(environmentInputSchema).min(1, { message: 'Au moins un environnement' }),
})
export type CreateProjectInput = z.input<typeof createProjectSchema>

// --- Variables d'environnement --------------------------------------------------------

export const variableKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: 'Nom de variable invalide' })
  .max(128)

export const variablesInputSchema = z.object({
  variables: z
    .array(
      z.object({
        key: variableKeySchema,
        /** `null` pour un secret existant : la valeur enregistrée est conservée. */
        value: z.string().max(65_536).nullable(),
        secret: z.boolean(),
      }),
    )
    .max(500)
    .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
      message: 'Une variable est définie deux fois',
    }),
})
export type VariablesInput = z.input<typeof variablesInputSchema>

export interface VariableView {
  key: string
  /** `null` pour un secret : la valeur n'est jamais renvoyée au navigateur. */
  value: string | null
  secret: boolean
}

// --- Vues renvoyées par l'API -----------------------------------------------------------

export interface AppSourceView {
  id: string
  name: string
  gitProviderId: string
  gitProviderName: string
  gitProviderType: 'gitlab' | 'github'
  repository: string
  repositoryUrl: string
  defaultBranch: string
  tagConvention: TagConvention
}

export interface TrackedServiceView {
  serviceName: string
  appSourceId: string
  registryId: string
  registryName: string
  /** Chemin dans le registry : groupe/projet/front */
  imageRepository: string
  /** Référence complète, sans tag : registry.gitlab.com/groupe/projet/front */
  image: string
}

export interface EnvironmentSourceView {
  appSourceId: string
  branch: string
  ref: string
  mode: 'tracking' | 'locked'
}

export interface EnvironmentView {
  id: string
  name: string
  slug: string
  composeProject: string
  sources: EnvironmentSourceView[]
  restartPolicy: RestartPolicy
  /** Projet lancé hors de Vercio, remplacé au premier déploiement réussi. */
  migratingFrom: string | null
  /** Dernier déploiement, et dernier déploiement réussi (version en service). */
  lastDeployment: DeploymentSummary | null
  current: DeploymentSummary | null
}

export interface ProjectSummary extends ProjectAppearance {
  id: string
  name: string
  slug: string
  description: string | null
  type: 'compose' | 'single'
  sources: { name: string; repository: string; gitProviderType: 'gitlab' | 'github' }[]
  environments: { name: string; slug: string; refs: string[]; locked: boolean }[]
  updatedAt: string
}

/** Services mis à jour sans coupure (la nouvelle version démarre avant l'arrêt de l'ancienne). */
export const zeroDowntimeInputSchema = z.object({
  services: z
    .array(
      // Nom de service Compose : il sert aussi de nom de fichier et de nom d'hôte nginx.
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/, { message: 'Nom de service invalide' }),
    )
    .max(50)
    .transform((items) => [...new Set(items)]),
})
export type ZeroDowntimeInput = z.input<typeof zeroDowntimeInputSchema>

export interface ProjectView extends Omit<ProjectSummary, 'sources' | 'environments'> {
  zeroDowntimeServices: string[]
  compose:
    { source: 'inline'; content: string } | { source: 'git'; appSourceId: string; path: string }
  sources: AppSourceView[]
  trackedServices: TrackedServiceView[]
  environments: EnvironmentView[]
}

// --- Sélecteur de version -------------------------------------------------------------------

export interface ImageVersion {
  serviceName: string
  digest: string
  /** Date de construction de l'image (champ `created`), ISO 8601. */
  pushedAt: string | null
}

export interface CommitInfo {
  sha: string
  shortSha: string
  message: string | null
  author: string | null
  date: string | null
  url: string
}

export interface VersionTag {
  name: string
  commit: CommitInfo
  /** Date de push la plus récente parmi les images du tag. */
  pushedAt: string | null
  /** Toutes les images suivies existent pour ce tag. */
  complete: boolean
  /** Services dont l'image manque (build en cours ou en échec). */
  missing: string[]
  images: ImageVersion[]
  pipelineUrl: string
}

export interface VersionChoices {
  appSourceId: string
  branch: string
  /** Origine des versions proposées : tags Git, ou derniers commits de la branche. */
  versionSource: 'git_tags' | 'commits'
  latest: {
    tag: string
    available: boolean
    missing: string[]
    pushedAt: string | null
    images: ImageVersion[]
    /** Version (tag ou commit) dont les images sont exactement celles du dernier build. */
    version: { name: string; commit: CommitInfo } | null
  }
  /** Les 5 versions les plus récentes de la branche (tags ou commits), du plus récent au plus ancien. */
  tags: VersionTag[]
  warnings: string[]
  checkedAt: string
}

// --- Déploiements -----------------------------------------------------------------------------

export interface DeploymentSummary {
  id: string
  environmentId: string
  trigger: 'user' | 'webhook' | 'rollback' | 'auto_rollback'
  status: DeploymentStatus
  username: string | null
  /** Par source : branche, version demandée (`latest` ou tag) et tag effectivement déployé. */
  versions: Record<string, { branch: string; ref: string; tag: string }>
  /** Par service suivi : image épinglée par digest. */
  images: Record<string, string>
  error: string | null
  rollbackOfId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface DeploymentLogLine {
  id: number
  at: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

export interface DeploymentDetail extends DeploymentSummary {
  /** Retour automatique déclenché par l'échec de ce déploiement. */
  autoRollbackId: string | null
  projectSlug: string
  environmentName: string
  composeOverride: string | null
  logs: DeploymentLogLine[]
}

/** Événements diffusés en direct pendant un déploiement (SSE). */
export type DeploymentEvent =
  { type: 'log'; log: DeploymentLogLine } | { type: 'status'; deployment: DeploymentSummary }
