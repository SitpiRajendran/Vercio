import type { BackupSummary } from './backups.js'
import type { ContainerView } from './operations.js'
import type { DeploymentSummary, ProjectAppearance } from './projects.js'

// --- Vue d'ensemble (page d'accueil) -----------------------------------------------------

export interface OverviewEnvironment {
  id: string
  name: string
  slug: string
  composeProject: string
  /** Une source au moins est verrouillée sur une version. */
  locked: boolean
  lastDeployment: DeploymentSummary | null
  current: DeploymentSummary | null
  containers: ContainerView[]
  /** Saturations CPU ou mémoire des dernières 24 h, par service. */
  alerts: ResourceAlert[]
  /** Dernière sauvegarde (null : jamais sauvegardé). */
  lastBackup: BackupSummary | null
}

/** Saturation du processeur ou de la mémoire d'un service (épisodes de 2 min au moins). */
export interface ResourceAlert {
  service: string
  metric: 'cpu' | 'memory'
  /** Épisodes sur les dernières 24 h. */
  episodes: number
  /** Un épisode est en cours. */
  active: boolean
  /** Pic observé : % d'un cœur (cpu) ou % de la limite mémoire. */
  peak: number
  lastAt: string
}

export interface OverviewProject extends ProjectAppearance {
  id: string
  name: string
  slug: string
  description: string | null
  type: 'compose' | 'single'
  /** Dans l'ordre de création : le premier est l'environnement principal. */
  environments: OverviewEnvironment[]
}

export interface OverviewView {
  projects: OverviewProject[]
  /** Démon Docker injoignable : les listes de conteneurs sont vides. */
  dockerError: string | null
}

/** Consommation récente d'un conteneur en marche. */
export interface ContainerUsage {
  id: string
  /** Dernière mesure ; null tant qu'il n'y en a pas deux. */
  cpuPercent: number | null
  memoryBytes: number
  memoryLimitBytes: number
  /** Dernières mesures (une toutes les 5 s), de la plus ancienne à la plus récente. */
  cpuHistory: number[]
  memoryHistory: number[]
}
