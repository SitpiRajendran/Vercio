import { hostname } from 'node:os'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDatabase>['db']

/**
 * Nom des connexions dans PostgreSQL (`pg_stat_activity`) : machine et processus, pour reconnaître
 * une connexion laissée par une instance arrêtée.
 */
export function connectionName(host = hostname(), pid = process.pid): string {
  return `vercio:${host.slice(0, 40)}:${pid}`
}

export function createDatabase(url: string, { applicationName = connectionName() } = {}) {
  const sql = postgres(url, {
    max: 10,
    onnotice: () => {},
    connection: { application_name: applicationName },
  })
  const db = drizzle(sql, { schema })
  return { db, sql }
}

export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder })
}

/** Message lisible pour une erreur de connexion à PostgreSQL. */
export function describeDatabaseError(error: unknown, url: string): string {
  type ErrorLike = { code?: string; message?: string; errors?: ErrorLike[] }
  const err = error as ErrorLike
  // Plusieurs adresses essayées (IPv4 et IPv6) : Node regroupe les échecs.
  const code = err?.code ?? err?.errors?.[0]?.code
  let target = 'la base'
  try {
    const parsed = new URL(url)
    target = `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`
  } catch {
    // URL invalide : le message d'origine suffit.
  }
  switch (code) {
    case 'ECONNREFUSED':
      return `PostgreSQL ne répond pas sur ${target} (connexion refusée) : la base est-elle démarrée ?`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Hôte de la base introuvable (${target}) : vérifiez DATABASE_URL`
    case 'ETIMEDOUT':
      return `Délai dépassé en joignant PostgreSQL sur ${target}`
    case '28P01':
    case '28000':
      return `PostgreSQL refuse l'identifiant ou le mot de passe de DATABASE_URL (${target})`
    case '3D000':
      return `La base indiquée dans DATABASE_URL n'existe pas (${target})`
    default:
      return `Connexion à PostgreSQL impossible (${target}) : ${err?.message || code || 'erreur inconnue'}`
  }
}

/**
 * Attend que PostgreSQL accepte les connexions (démarrage simultané de la base et de Vercio).
 * Lève une erreur lisible si la base reste injoignable.
 */
export async function waitForDatabase(
  sql: ReturnType<typeof postgres>,
  url: string,
  {
    timeoutMs = 60_000,
    intervalMs = 2_000,
    onRetry = (message: string) => console.warn(message),
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    try {
      await sql`select 1`
      return
    } catch (error) {
      const message = describeDatabaseError(error, url)
      const code = (error as { code?: string })?.code
      // Mauvais identifiants ou base absente : attendre ne changera rien.
      const permanent = code === '28P01' || code === '28000' || code === '3D000'
      if (permanent || Date.now() + intervalMs > deadline) throw new Error(message)
      if (!announced) {
        onRetry(`${message} Nouvelle tentative pendant ${Math.round(timeoutMs / 1000)} s…`)
        announced = true
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}

/** Clé du verrou consultatif « une seule instance de Vercio par base » ('vercio' en hexadécimal). */
const INSTANCE_LOCK_KEY = 0x76657263696f
// Un verrou bigint apparaît dans pg_locks en deux moitiés de 32 bits.
const LOCK_CLASSID = Math.floor(INSTANCE_LOCK_KEY / 2 ** 32)
const LOCK_OBJID = INSTANCE_LOCK_KEY % 2 ** 32

interface LockHolder {
  pid: number
  application_name: string
  client_addr: string | null
  backend_start: Date | string
}

/** Le processus nommé par la connexion n'existe plus sur cette machine (ou c'est nous-mêmes). */
function isStale(holder: LockHolder): boolean {
  const match = /^vercio:(.+):(\d+)$/.exec(holder.application_name)
  if (!match || match[1] !== hostname().slice(0, 40)) return false
  const pid = Number(match[2])
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: string }).code === 'ESRCH'
  }
}

function describeHolder(holder: LockHolder): string {
  const since = new Date(holder.backend_start).toLocaleTimeString('fr-FR')
  const from = holder.client_addr ? ` depuis ${holder.client_addr}` : ''
  return `${holder.application_name || 'connexion sans nom'}${from}, connectée à ${since}`
}

/**
 * Une seule instance par base : deux instances lanceraient les déploiements, les notifications et
 * les alertes en double. Le verrou est tenu par une connexion réservée jusqu'à l'arrêt du processus.
 * Une connexion laissée par une instance arrêtée de cette machine (processus tué, redémarrage de
 * `pnpm dev`) est fermée ; sinon on attend quelques secondes que l'autre instance s'arrête.
 */
export async function acquireInstanceLock(
  sql: ReturnType<typeof postgres>,
  {
    timeoutMs = 15_000,
    intervalMs = 1_000,
    onWait = (message: string) => console.warn(message),
  } = {},
): Promise<() => Promise<void>> {
  const connection = await sql.reserve()
  let deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    const [row] = await connection<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${INSTANCE_LOCK_KEY}) as locked`
    if (row?.locked) {
      return async () => {
        await connection`select pg_advisory_unlock(${INSTANCE_LOCK_KEY})`.catch(() => {})
        connection.release()
      }
    }
    const [holder] = await connection<LockHolder[]>`
      select a.pid, a.application_name, host(a.client_addr) as client_addr, a.backend_start
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted
        and l.database = (select oid from pg_database where datname = current_database())
        and l.classid = ${LOCK_CLASSID} and l.objid = ${LOCK_OBJID}
      limit 1`
    if (holder && isStale(holder)) {
      onWait(`Connexion laissée par une instance arrêtée (${describeHolder(holder)}) : fermeture.`)
      await connection`select pg_terminate_backend(${holder.pid})`
      // Le verrou est libéré quand le processus serveur de la connexion se termine.
      deadline = Math.max(deadline, Date.now() + 2_000)
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    const who = holder ? ` (${describeHolder(holder)})` : ''
    if (Date.now() >= deadline) {
      connection.release()
      throw new Error(
        `une autre instance de Vercio utilise déjà cette base de données${who} : une seule instance peut tourner par base (arrêtez l’autre instance, ou indiquez une autre DATABASE_URL)`,
      )
    }
    if (!announced) {
      onWait(
        `Une autre instance de Vercio utilise cette base${who} : attente de son arrêt (${Math.round(timeoutMs / 1000)} s au plus)…`,
      )
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
  }
}
