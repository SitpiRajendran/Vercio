import { z } from 'zod'

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.boolean(),
  docker: z.boolean(),
  /** Démarrage du processus : change après un redémarrage (restauration de Vercio). */
  startedAt: z.string().optional(),
})
export type Health = z.infer<typeof healthSchema>

export const dockerInfoSchema = z.object({
  serverVersion: z.string(),
  operatingSystem: z.string(),
  architecture: z.string(),
  cpus: z.number(),
  memoryBytes: z.number(),
  containers: z.object({
    total: z.number(),
    running: z.number(),
    paused: z.number(),
    stopped: z.number(),
  }),
  images: z.number(),
})
export type DockerInfo = z.infer<typeof dockerInfoSchema>

// --- Mises à jour de Vercio ------------------------------------------------------------------

/** Dernière version publiée (release GitHub du dépôt public). */
export interface VercioRelease {
  /** `0.3.0`, sans « v ». */
  version: string
  name: string
  /** Notes de version (Markdown du changelog). */
  notes: string
  url: string
  publishedAt: string | null
}

export type UpdatePhase =
  'backup' | 'starting' | 'pulling' | 'restarting' | 'done' | 'failed' | 'rolled_back'

/** Mise à jour en cours, ou dernière mise à jour terminée. */
export interface UpdateRun {
  from: string
  to: string
  phase: UpdatePhase
  message: string | null
  /** Où se trouve la sauvegarde faite avant (destination ou fichier). */
  backup: string | null
  startedAt: string
  finishedAt: string | null
}

export interface UpdateStatus {
  current: string
  latest: VercioRelease | null
  /** Une version plus récente que celle en service est publiée. */
  available: boolean
  checkedAt: string | null
  /** Échec de la dernière vérification. */
  error: string | null
  /** Mise à jour possible depuis l'interface ; sinon `reason` dit pourquoi. */
  canUpdate: boolean
  reason: string | null
  run: UpdateRun | null
}

export const updateStartSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, { message: 'Version invalide' }),
})
export type UpdateStartInput = z.infer<typeof updateStartSchema>

/** Compare deux versions `X.Y.Z` : négatif si a < b. Null si l'une n'est pas de ce format. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number)
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return 0
}

// --- Infos techniques (« pour les nerds ») ---------------------------------------------------

export interface SystemInfo {
  vercio: {
    version: string
    startedAt: string
    uptimeSeconds: number
    node: string
    platform: string
    timezone: string
    publicUrl: string
    dataDir: string
    localAuth: boolean
    sso: boolean
    updateCheck: boolean
  }
  database: {
    host: string
    port: string
    name: string
    user: string
    /** `PostgreSQL 17.2` */
    server: string | null
    sizeBytes: number | null
    /** Temps d'une requête simple, en millisecondes. */
    latencyMs: number | null
    connections: number | null
    migrations: number | null
    error: string | null
  }
  docker: DockerInfo | { error: string }
  /** Conteneur de Vercio ; null hors conteneur. */
  container: {
    id: string
    image: string
    project: string | null
    service: string | null
    workingDir: string | null
    mounts: { source: string; destination: string }[]
  } | null
  counts: {
    projects: number
    environments: number
    deployments: number
    users: number
    backups: number
  }
}
