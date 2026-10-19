import { z } from 'zod'
import type { ComposeAnalysis } from './projects.js'

/**
 * Projet Compose lancé hors de Vercio (`docker compose up` à la main), repéré par les labels
 * que Compose pose sur ses conteneurs.
 */
export interface ExternalComposeProject {
  /** Nom du projet Compose (`com.docker.compose.project`). */
  name: string
  /** Dossier d'où il a été lancé, sur l'hôte. */
  workingDir: string | null
  configFiles: string[]
  services: { name: string; image: string; state: string; status: string; ports: string[] }[]
  /** Volumes nommés du projet : repris tels quels par le projet Vercio (aucune copie). */
  volumes: { key: string; name: string; services: string[] }[]
  /** Montages de fichiers ou dossiers du dossier d'origine (`./data`) : à copier à la main. */
  relativeBinds: { service: string; source: string; target: string }[]
  /** Fichier Compose lu sur le disque, si Vercio y a accès. */
  compose:
    | { path: string; content: string; analysis: ComposeAnalysis }
    | { path: string | null; error: string }
  /** `.env` du projet, si Vercio y a accès. */
  env:
    | { path: string; variables: { key: string; value: string; secret: boolean }[] }
    | { path: string | null; error: string }
    | null
}

/** Reprise d'un projet lancé hors de Vercio, à son premier déploiement. */
export const environmentMigrationSchema = z.object({
  /** Projet Compose d'origine : arrêté au premier déploiement, supprimé s'il réussit. */
  composeProject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, { message: 'Nom de projet Compose invalide' }),
  /** Volume du fichier Compose → volume Docker existant à réutiliser. */
  volumes: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, { message: 'Nom de volume invalide' }),
    )
    .default({}),
})
export type EnvironmentMigration = z.output<typeof environmentMigrationSchema>
