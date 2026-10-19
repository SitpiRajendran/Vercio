import { z } from 'zod'
import { gitProviderTypeSchema, type GitProviderType } from './domain.js'

const httpUrl = z
  .url({ message: 'URL invalide' })
  .refine((value) => /^https?:\/\//.test(value), { message: 'URL http(s) attendue' })
  .transform((value) => value.replace(/\/+$/, ''))

const optionalPem = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .refine((value) => !value || value.includes('-----BEGIN CERTIFICATE-----'), {
    message: 'Certificat PEM attendu',
  })

const name = z.string().trim().min(1, { message: 'Nom requis' }).max(60)

// --- Fournisseurs Git ----------------------------------------------------------------

export const gitProviderInputSchema = z.object({
  name,
  type: gitProviderTypeSchema,
  /**
   * URL de l'instance (interface web) : https://gitlab.com, https://gitlab.example.com,
   * https://github.com ou https://github.example.com (GitHub Enterprise Server).
   */
  url: httpUrl,
  /** Vide lors d'une modification : le token enregistré est conservé. */
  token: z.string().trim().max(512).optional(),
  caCertificate: optionalPem,
  /**
   * Création seulement : registry d'images de la même instance (registry GitLab, GHCR),
   * lu avec le même token. null : aucun.
   */
  imageRegistry: z
    .object({ url: z.string().trim().min(1, { message: 'Adresse du registry requise' }).max(255) })
    .nullable()
    .optional(),
})
export type GitProviderInput = z.input<typeof gitProviderInputSchema>

export const connectionCheckSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  warnings: z.array(z.string()),
  checkedAt: z.string(),
})
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>

export interface GitProviderView {
  id: string
  name: string
  type: 'gitlab' | 'github'
  url: string
  tokenHint: string
  caCertificate: string | null
  lastCheck: ConnectionCheck | null
  usedBy: number
  /** Registries d'images qui réutilisent ce token. */
  registries: { id: string; name: string; url: string }[]
}

/**
 * Registry d'images d'une instance GitLab ou GitHub : registry.gitlab.com, ghcr.io ; sur une
 * instance auto-hébergée, l'adresse la plus courante (à corriger si besoin).
 */
export function defaultImageRegistry(type: GitProviderType, url: string): string {
  const host = url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase()
  if (type === 'gitlab') return host === 'gitlab.com' ? 'registry.gitlab.com' : `registry.${host}`
  return host === 'github.com' || host === 'www.github.com' ? 'ghcr.io' : `containers.${host}`
}

// --- Registries ----------------------------------------------------------------------

export const registryInputSchema = z.object({
  name,
  type: z.enum(['gitlab', 'ghcr', 'oci']),
  /** Hôte du registry, avec ou sans schéma : registry.gitlab.com, https://harbor.example.com */
  url: z
    .string()
    .trim()
    .min(1, { message: 'URL requise' })
    .transform((value) => value.replace(/\/+$/, '')),
  username: z.string().trim().max(256).optional(),
  /** Vide lors d'une modification : le mot de passe enregistré est conservé. */
  password: z.string().max(1024).optional(),
  /** Registry GitLab ou GHCR : réutilise le token de ce fournisseur si aucun mot de passe n'est saisi. */
  gitProviderId: z.uuid().optional().nullable(),
  insecure: z.boolean().default(false),
  caCertificate: optionalPem,
})
export type RegistryInput = z.input<typeof registryInputSchema>

export interface RegistryView {
  id: string
  name: string
  type: 'gitlab' | 'ghcr' | 'oci'
  url: string
  username: string | null
  hasPassword: boolean
  gitProviderId: string | null
  insecure: boolean
  caCertificate: string | null
  lastCheck: ConnectionCheck | null
  usedBy: number
}

/** Préfixe d'un token, pour le reconnaître sans l'exposer. */
export function tokenHint(token: string): string {
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** URL de l'API REST d'un fournisseur, déduite de l'URL de l'instance. */
export function gitProviderApiUrl(type: GitProviderType, url: string): string {
  if (type === 'gitlab') return `${url}/api/v4`
  return /^https?:\/\/(www\.)?github\.com(:443)?\/?$/i.test(url)
    ? 'https://api.github.com'
    : `${url}/api/v3`
}

/** Type de fournisseur Git attendu pour réutiliser son token avec un registry. */
export const REGISTRY_PROVIDER_TYPE: Partial<Record<RegistryView['type'], GitProviderType>> = {
  gitlab: 'gitlab',
  ghcr: 'github',
}
