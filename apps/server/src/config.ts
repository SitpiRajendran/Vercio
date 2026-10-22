import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1')

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(9000),
    PUBLIC_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    VERCIO_SECRET_KEY: z.string().min(32, 'VERCIO_SECRET_KEY doit contenir au moins 32 caractères'),
    /**
     * Rendu absolu : Docker est lancé depuis le dossier de l'environnement, où un chemin relatif
     * (`./data` en développement) désignerait un autre dossier.
     */
    VERCIO_DATA_DIR: z
      .string()
      .default('/var/lib/vercio')
      .transform((value) => resolve(value)),
    DOCKER_SOCKET: z.string().optional(),
    /**
     * Code à saisir sur la page de premier lancement (création du premier administrateur).
     * Sans valeur, un code aléatoire est affiché dans le journal du serveur.
     */
    VERCIO_SETUP_CODE: z
      .string()
      .trim()
      .min(8, 'VERCIO_SETUP_CODE : 8 caractères minimum')
      .optional(),
    /** Installation sans interface : premier administrateur créé directement au démarrage. */
    VERCIO_ADMIN_USERNAME: z.string().min(1).default('admin'),
    VERCIO_ADMIN_PASSWORD: z.string().min(8).optional(),
    /** Recherche des nouvelles versions de Vercio sur GitHub (`false` : jamais). */
    VERCIO_UPDATE_CHECK: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    VERCIO_LOCAL_AUTH: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
    /**
     * Proxys de confiance pour X-Forwarded-For (adresse des webhooks, limitation de débit, audit) :
     * nombre de proxys devant Vercio (défaut 1), liste d'IP / CIDR, `true` ou `false`.
     */
    TRUST_PROXY: z
      .string()
      .default('1')
      .transform((value): boolean | number | string[] => {
        if (value === 'true' || value === 'false') return value === 'true'
        if (/^\d+$/.test(value)) return Number(value)
        return value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      }),
    // --- SSO OpenID Connect (Keycloak ou tout fournisseur OIDC) ---
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    /**
     * Revendications où chercher les rôles `vercio-*`, séparées par des virgules.
     * `{clientId}` est remplacé par OIDC_CLIENT_ID. Par défaut : rôles du client, du realm, et groupes.
     */
    OIDC_ROLES_CLAIMS: z
      .string()
      .default('resource_access.{clientId}.roles,realm_access.roles,groups'),
    OIDC_PROVIDER_NAME: z.string().default('Keycloak'),
    WEB_DIST_DIR: z
      .string()
      .optional()
      .transform((value) => (value ? resolve(value) : undefined)),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: booleanFromEnv,
  })
  .refine((env) => !env.OIDC_ISSUER || (env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET), {
    message: 'OIDC_CLIENT_ID et OIDC_CLIENT_SECRET sont requis avec OIDC_ISSUER',
    path: ['OIDC_ISSUER'],
  })
  .refine((env) => env.OIDC_ISSUER || env.VERCIO_LOCAL_AUTH, {
    message: 'Activez au moins un mode de connexion (OIDC_ISSUER ou VERCIO_LOCAL_AUTH)',
    path: ['VERCIO_LOCAL_AUTH'],
  })

export type Config = Omit<z.infer<typeof envSchema>, 'DOCKER_SOCKET'> & { DOCKER_SOCKET: string }

/**
 * Socket Docker : DOCKER_SOCKET, sinon DOCKER_HOST (unix://…), sinon le premier socket présent
 * parmi les emplacements usuels (Linux, Docker Desktop sur Mac, Colima, Rancher Desktop).
 */
export function resolveDockerSocket(
  env: { DOCKER_SOCKET?: string; DOCKER_HOST?: string },
  exists: (path: string) => boolean = existsSync,
  home = homedir(),
): string {
  if (env.DOCKER_SOCKET) return resolve(env.DOCKER_SOCKET)
  if (env.DOCKER_HOST?.startsWith('unix://'))
    return resolve(env.DOCKER_HOST.slice('unix://'.length))
  const candidates = [
    '/var/run/docker.sock',
    join(home, '.docker/run/docker.sock'),
    join(home, '.colima/default/docker.sock'),
    join(home, '.rd/docker.sock'),
  ]
  return candidates.find((path) => exists(path)) ?? candidates[0]!
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Docker Compose transmet `VAR=` pour une variable non renseignée : vide = absente.
  const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const result = envSchema.safeParse(defined)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Configuration invalide :\n${details}`)
  }
  return {
    ...result.data,
    DOCKER_SOCKET: resolveDockerSocket({ ...result.data, DOCKER_HOST: defined.DOCKER_HOST }),
  }
}
