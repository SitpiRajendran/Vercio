import { z } from 'zod'

/** Valeurs par défaut, identiques à celles des variables OIDC_* du fichier .env. */
export const SSO_DEFAULTS = {
  providerName: 'Keycloak',
  scopes: 'openid profile email',
  rolesClaims: 'resource_access.{clientId}.roles,realm_access.roles,groups',
} as const

/** Configuration du SSO depuis l'interface (Paramètres → Connexion SSO). */
export const ssoSettingsInputSchema = z.object({
  enabled: z.boolean(),
  issuer: z
    .string()
    .trim()
    .min(1, { message: 'Adresse du fournisseur requise' })
    .pipe(z.url({ message: 'Adresse invalide (https://…/realms/mon-realm)' })),
  clientId: z.string().trim().min(1, { message: 'Identifiant du client requis' }).max(255),
  /** Vide : le secret déjà enregistré est conservé. */
  clientSecret: z.string().max(1024).optional(),
  providerName: z
    .string()
    .trim()
    .min(1, { message: 'Nom requis' })
    .max(40, { message: '40 caractères maximum' }),
  scopes: z.string().trim().min(1).max(255),
  rolesClaims: z.string().trim().min(1).max(1024),
})
export type SsoSettingsInput = z.input<typeof ssoSettingsInputSchema>

export interface SsoSettingsView {
  /** `env` : variables OIDC_* du .env, prioritaires (lecture seule) ; `none` : rien de configuré. */
  source: 'env' | 'settings' | 'none'
  enabled: boolean
  issuer: string
  clientId: string
  hasSecret: boolean
  providerName: string
  scopes: string
  rolesClaims: string
  /** À déclarer dans le client Keycloak. */
  redirectUri: string
  postLogoutRedirectUri: string
  backchannelLogoutUri: string
  /** Comptes locaux actifs : le SSO ne remplace jamais l'accès de secours. */
  localAuth: boolean
}
