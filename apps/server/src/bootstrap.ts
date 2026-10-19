import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.js'
import type { Database } from './db/client.js'
import { hosts, users } from './db/schema.js'
import { hashPassword, temporaryPassword } from './lib/password.js'

/** Hôte local : en V1, tous les environnements tournent sur le démon Docker local. */
export async function ensureLocalHost(db: Database): Promise<void> {
  await db
    .insert(hosts)
    .values({ name: 'local', type: 'local' })
    .onConflictDoNothing({ target: hosts.name })
}

/** Il n'existe encore aucun compte local : la page de premier lancement est proposée. */
export async function setupRequired(db: Database, config: Config): Promise<boolean> {
  if (!config.VERCIO_LOCAL_AUTH) return false
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.provider, 'local'))
    .limit(1)
  return existing.length === 0
}

/**
 * Installation sans interface (VERCIO_ADMIN_PASSWORD défini) : le premier administrateur est
 * créé au démarrage, avec un mot de passe temporaire à remplacer à la première connexion.
 * Sinon, il est créé depuis la page de premier lancement.
 */
export async function ensureLocalAdmin(
  db: Database,
  config: Config,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!config.VERCIO_ADMIN_PASSWORD || !(await setupRequired(db, config))) return
  const username = config.VERCIO_ADMIN_USERNAME
  await db.insert(users).values({
    provider: 'local',
    subject: username,
    username,
    displayName: 'Administrateur',
    passwordHash: await hashPassword(config.VERCIO_ADMIN_PASSWORD),
    roles: ['vercio-admin'],
    passwordChangeRequired: true,
  })
  log.info({ username }, 'Compte administrateur local créé')
}

/**
 * Code de premier lancement : celui de VERCIO_SETUP_CODE, sinon un code aléatoire affiché dans
 * le journal. Il empêche qu'un inconnu crée le premier administrateur d'une installation neuve.
 */
export async function setupCode(
  db: Database,
  config: Config,
  log: FastifyBaseLogger,
): Promise<string> {
  const code = config.VERCIO_SETUP_CODE ?? temporaryPassword().slice(0, 12)
  if (await setupRequired(db, config)) {
    log.warn(
      config.VERCIO_SETUP_CODE
        ? 'Premier lancement : ouvrez Vercio et saisissez le code d’installation (VERCIO_SETUP_CODE du fichier .env).'
        : `Premier lancement : ouvrez Vercio et saisissez le code d’installation ${code}`,
    )
  }
  return code
}
