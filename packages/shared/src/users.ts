import { z } from 'zod'
import { roleSchema, type Role } from './auth.js'

/** Identifiant d'un compte local : minuscules, chiffres, point, tiret, souligné. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, {
    message: '2 à 64 caractères : lettres minuscules, chiffres, « . », « - » ou « _ »',
  })

const profileFields = {
  displayName: z.string().trim().min(1, { message: 'Nom requis' }).max(100),
  email: z
    .union([z.email({ message: 'Adresse email invalide' }), z.literal('')])
    .optional()
    .transform((value) => value || null),
  role: roleSchema,
}

export const userCreateSchema = z.object({ username: usernameSchema, ...profileFields })
export type UserCreateInput = z.input<typeof userCreateSchema>

/** Compte SSO : seul `disabled` est modifiable, le reste vient du fournisseur. */
export const userUpdateSchema = z.object({ ...profileFields, disabled: z.boolean() })
export type UserUpdateInput = z.input<typeof userUpdateSchema>

export interface UserView {
  id: string
  username: string
  displayName: string
  email: string | null
  provider: 'local' | 'oidc'
  roles: Role[]
  disabled: boolean
  /** Compte local : double authentification configurée. */
  totpEnabled: boolean
  /** Compte local : applications d'authentification enregistrées. */
  totpDevices: number
  /** Compte local : mot de passe temporaire pas encore remplacé. */
  passwordChangeRequired: boolean
  lastLoginAt: string | null
  createdAt: string
}

/** Réponse d'une création ou d'une réinitialisation : le mot de passe n'est montré qu'une fois. */
export interface UserWithPassword {
  user: UserView
  temporaryPassword: string
}
