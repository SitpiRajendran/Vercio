import { z } from 'zod'

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
export const environmentLinkSchema = z.object({
  targetEnvironmentId: z.uuid({ message: 'Projet requis' }),
  service: z.string().trim().min(1, { message: 'Service requis' }).max(100),
  /** Nom sous lequel le service est joint ; ignoré si ce service est déjà partagé. */
  alias: sharedNetworkAliasSchema,
  /** Services de cet environnement reliés ; null : tous. */
  services: z.array(z.string().min(1).max(100)).min(1).nullable(),
})
export type EnvironmentLinkInput = z.input<typeof environmentLinkSchema>

export interface EnvironmentLinkResult {
  network: SharedNetworkView
  /** Conteneurs en marche branchés tout de suite ; sinon, au prochain déploiement. */
  applied: boolean
  /** Raison quand le branchement immédiat n'a pas pu se faire. */
  detail: string | null
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
