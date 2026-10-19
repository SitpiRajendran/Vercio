import type { DatabaseEngine } from '@vercio/shared'

/** Moteur d'après l'image (`postgres:16`, `bitnami/postgresql`, `mariadb:11`, `mongo:7`…). */
export function databaseEngine(image: string): DatabaseEngine | null {
  const repository = image.split('@')[0]!.replace(/:[^/:]+$/, '')
  const name = repository.split('/').at(-1)!.toLowerCase()
  if (/^(postgres|postgresql|postgis|timescaledb(-ha)?|pgvector)$/.test(name)) return 'postgres'
  if (/^mariadb$/.test(name)) return 'mariadb'
  if (/^(mysql|mysql-server|percona-server|percona)$/.test(name)) return 'mysql'
  if (/^(mongo|mongodb|mongodb-community-server)$/.test(name)) return 'mongo'
  return null
}

/** Extension du fichier exporté (déjà compressé par Vercio ou par l'outil). */
export const DUMP_EXTENSION: Record<DatabaseEngine, string> = {
  postgres: 'sql.gz',
  mysql: 'sql.gz',
  mariadb: 'sql.gz',
  mongo: 'archive.gz',
}

/**
 * Scripts lancés dans le conteneur de la base (`sh -c`) : les identifiants viennent de ses
 * propres variables (images officielles et Bitnami), jamais de Vercio.
 */
const POSTGRES_AUTH =
  'export PGUSER="${POSTGRES_USER:-${POSTGRESQL_USERNAME:-postgres}}"; ' +
  'export PGPASSWORD="${POSTGRES_PASSWORD:-${POSTGRESQL_PASSWORD:-$POSTGRESQL_POSTGRES_PASSWORD}}"; ' +
  'for i in $(seq 1 60); do pg_isready -q && break; sleep 1; done; '

const MYSQL_AUTH =
  'ROOT="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"; ' +
  'if [ -n "$ROOT" ] || [ -z "${MARIADB_USER:-${MYSQL_USER:-}}" ]; then ' +
  'export MYSQL_PWD="$ROOT"; USR=root; ' +
  'else export MYSQL_PWD="${MARIADB_PASSWORD:-${MYSQL_PASSWORD:-}}"; USR="${MARIADB_USER:-$MYSQL_USER}"; ' +
  'DB="${MARIADB_DATABASE:-${MYSQL_DATABASE:-}}"; fi; '

const MONGO_AUTH =
  'AUTH=""; if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then ' +
  'AUTH="--username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin"; fi; '

/** Écrit l'export sur la sortie standard. */
export function dumpScript(engine: DatabaseEngine): string {
  switch (engine) {
    case 'postgres':
      return `${POSTGRES_AUTH}exec pg_dumpall --clean --if-exists`
    case 'mysql':
    case 'mariadb':
      // Avec un utilisateur sans droits root : sa base seulement.
      return (
        `${MYSQL_AUTH}DUMP="$(command -v mariadb-dump || command -v mysqldump)"; ` +
        'if [ -n "${DB:-}" ]; then exec "$DUMP" -u"$USR" --single-transaction --routines --triggers --databases "$DB"; ' +
        'else exec "$DUMP" -u"$USR" --single-transaction --routines --triggers --events --all-databases --add-drop-database; fi'
      )
    case 'mongo':
      return `${MONGO_AUTH}exec mongodump $AUTH --archive --gzip --quiet`
  }
}

/** Lit l'export sur l'entrée standard et remplace les données. */
export function restoreScript(engine: DatabaseEngine): string {
  switch (engine) {
    case 'postgres':
      // Erreurs non bloquantes (ex. rôle courant non supprimable) : comme `pg_dumpall --clean`.
      return `${POSTGRES_AUTH}exec psql -X -q -d postgres -v ON_ERROR_STOP=0`
    case 'mysql':
    case 'mariadb':
      return (
        `${MYSQL_AUTH}CLI="$(command -v mariadb || command -v mysql)"; ` +
        'for i in $(seq 1 60); do "$CLI" -u"$USR" -e "select 1" >/dev/null 2>&1 && break; sleep 1; done; ' +
        'exec "$CLI" -u"$USR"'
      )
    case 'mongo':
      return (
        `${MONGO_AUTH}SH="$(command -v mongosh || command -v mongo)"; ` +
        'for i in $(seq 1 60); do "$SH" $AUTH --quiet --eval "db.runCommand({ping:1})" >/dev/null 2>&1 && break; sleep 1; done; ' +
        `exec mongorestore $AUTH --archive --gzip --drop --quiet`
      )
  }
}
