import { z } from 'zod'

export const ROLES = ['vercio-admin', 'vercio-deployer', 'vercio-viewer'] as const
export const roleSchema = z.enum(ROLES)
export type Role = z.infer<typeof roleSchema>

const ROLE_LEVEL: Record<Role, number> = {
  'vercio-viewer': 1,
  'vercio-deployer': 2,
  'vercio-admin': 3,
}

/** Noms affichés des rôles. */
export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
  'vercio-admin': { label: 'Administrateur', description: 'Tout, y compris les paramètres' },
  'vercio-deployer': {
    label: 'Déployeur',
    description: 'Déployer, verrouiller, redémarrer, variables',
  },
  'vercio-viewer': { label: 'Lecteur', description: 'Consultation seule' },
}

/** Un rôle supérieur inclut les droits des rôles inférieurs. */
export function hasRole(roles: readonly Role[], required: Role): boolean {
  return roles.some((role) => ROLE_LEVEL[role] >= ROLE_LEVEL[required])
}

export const sessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  roles: z.array(roleSchema),
  provider: z.enum(['local', 'oidc']),
})
export type SessionUser = z.infer<typeof sessionUserSchema>

export const localLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})
export type LocalLogin = z.infer<typeof localLoginSchema>

export const authConfigSchema = z.object({
  localEnabled: z.boolean(),
  /** Aucun compte local : afficher la page de premier lancement (création du premier admin). */
  setupRequired: z.boolean(),
  oidcEnabled: z.boolean(),
  oidcProviderName: z.string().nullable(),
})
export type AuthConfig = z.infer<typeof authConfigSchema>

/** Réponse d'une connexion locale : la double authentification est toujours exigée. */
export const localLoginResultSchema = z.object({
  next: z.enum(['totp', 'totp_setup']),
})
export type LocalLoginResult = z.infer<typeof localLoginResultSchema>

/** Après le code TOTP : connecté, ou mot de passe temporaire à remplacer d'abord. */
export const totpVerifyResultSchema = z.object({
  next: z.enum(['done', 'password_change']),
})
export type TotpVerifyResult = z.infer<typeof totpVerifyResultSchema>

/** Règle des mots de passe des comptes locaux. */
export const PASSWORD_MIN_LENGTH = 12
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: `${PASSWORD_MIN_LENGTH} caractères minimum` })
  .max(256, { message: '256 caractères maximum' })

/** Remplacement du mot de passe temporaire, pendant la connexion. */
export const initialPasswordSchema = z.object({ password: newPasswordSchema })
export type InitialPassword = z.infer<typeof initialPasswordSchema>

/** Changement de mot de passe par l'utilisateur connecté. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: newPasswordSchema,
})
export type ChangePassword = z.infer<typeof changePasswordSchema>

export const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, { message: 'Code à 6 chiffres' }),
})
export type TotpCode = z.infer<typeof totpCodeSchema>

export const totpSetupSchema = z.object({
  secret: z.string(),
  uri: z.string(),
  qrSvg: z.string(),
})
export type TotpSetup = z.infer<typeof totpSetupSchema>

export const logoutResultSchema = z.object({
  /** URL de déconnexion du fournisseur SSO, à ouvrir pour fermer aussi la session Keycloak. */
  redirectTo: z.string().nullable(),
})
export type LogoutResult = z.infer<typeof logoutResultSchema>

/** Codes d'erreur renvoyés à l'écran de connexion après un échec SSO (`/connexion?erreur=…`). */
export const SSO_ERRORS = {
  no_role:
    "Votre compte n'a aucun rôle Vercio. Demandez à un administrateur de vous attribuer vercio-viewer, vercio-deployer ou vercio-admin.",
  disabled: 'Votre compte Vercio est désactivé.',
  failed: 'La connexion SSO a échoué. Réessayez.',
  unavailable: 'Le fournisseur SSO est injoignable pour le moment.',
} as const
export type SsoError = keyof typeof SSO_ERRORS

/** Premier lancement : création du premier administrateur. */
export const firstRunSchema = z.object({
  setupCode: z.string().trim().min(1, { message: 'Code d’installation requis' }).max(128),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, {
      message: '2 à 64 caractères : lettres minuscules, chiffres, « . », « - » ou « _ »',
    }),
  email: z.email({ message: 'Adresse email invalide' }),
  password: newPasswordSchema,
})
export type FirstRunInput = z.input<typeof firstRunSchema>
