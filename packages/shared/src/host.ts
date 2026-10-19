import { z } from 'zod'

/** Conteneur de l'hôte (page Conteneurs), géré ou non par Vercio. */
export interface HostContainerView {
  id: string
  name: string
  image: string
  state: string
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  ports: string[]
  createdAt: string
  /** Projet Compose, s'il y en a un. */
  composeProject: string | null
  service: string | null
  /** Projet et environnement Vercio (labels `vercio.*`). */
  vercio: { project: string; environment: string } | null
}

export const CLEANUP_TARGETS = [
  'images-dangling',
  'images-unused',
  'containers',
  'volumes',
  'build-cache',
] as const
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number]

export const CLEANUP_LABELS: Record<CleanupTarget, { label: string; hint: string }> = {
  'images-dangling': {
    label: 'Images sans tag',
    hint: 'Couches orphelines laissées par les mises à jour d’images : aucun risque.',
  },
  'images-unused': {
    label: 'Images inutilisées',
    hint: 'Toutes les images sans conteneur, y compris les versions précédentes gardées pour un retour arrière (elles seront retéléchargées si besoin).',
  },
  containers: {
    label: 'Conteneurs arrêtés hors Vercio',
    hint: 'Les conteneurs arrêtés des projets Vercio sont gardés. Les volumes anonymes des conteneurs supprimés deviennent inutilisés (voir « Volumes anonymes »).',
  },
  volumes: {
    label: 'Volumes anonymes inutilisés',
    hint: 'Volumes sans nom laissés par d’anciens conteneurs. Les volumes nommés (bases de données, fichiers des projets) ne sont jamais supprimés.',
  },
  'build-cache': {
    label: 'Cache de build',
    hint: 'Cache de docker build, reconstruit au besoin.',
  },
}

export interface CleanupPreview {
  targets: Record<CleanupTarget, { count: number; bytes: number }>
  measuredAt: string
}

export const cleanupInputSchema = z.object({
  targets: z.array(z.enum(CLEANUP_TARGETS)).min(1, { message: 'Choisissez au moins un élément' }),
})

export interface CleanupResult {
  targets: Partial<Record<CleanupTarget, { deleted: number; bytes: number; error?: string }>>
  totalBytes: number
}
