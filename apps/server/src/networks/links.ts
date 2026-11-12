import { randomInt } from 'node:crypto'
import { Readable } from 'node:stream'
import type { LinkKind } from '@vercio/shared'
import { databaseEngine } from '../backups/databases.js'
import type { CommandRunner } from '../deploy/command.js'

/** Type d'un service d'après son image (`postgres:17`, `redis:7-alpine`, `valkey/valkey`…). */
export function linkKind(image: string | null): LinkKind {
  if (!image) return 'service'
  const engine = databaseEngine(image)
  if (engine) return engine
  const repository = image.split('@')[0]!.replace(/:[^/:]+$/, '')
  const name = repository.split('/').at(-1)!.toLowerCase()
  if (/^(redis|redis-stack|redis-stack-server|valkey|keydb|dragonfly)$/.test(name)) return 'redis'
  return 'service'
}

/** Premier port conteneur déclaré (`8080`, `"3000:3000"`, `127.0.0.1:80:8080/tcp`). */
export function declaredPort(ports: string[]): number | null {
  for (const spec of ports) {
    const target = spec.split('/')[0]!.split(':').at(-1)!
    const port = Number(target.split('-')[0])
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  }
  return null
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** Mot de passe sans caractère spécial : sûr dans une URL et dans le SQL généré. */
export function randomPassword(length = 32): string {
  let value = ''
  for (let i = 0; i < length; i++) value += ALPHABET[randomInt(ALPHABET.length)]
  return value
}

/**
 * Commandes lancées dans le conteneur de la base (`sh -c`), avec ses propres identifiants
 * d'administration (variables de l'image) ; les instructions, mot de passe compris, arrivent
 * sur l'entrée standard et n'apparaissent donc jamais dans la liste des processus.
 */
const SCRIPTS: Record<'postgres' | 'mysql' | 'mariadb' | 'mongo', string> = {
  postgres:
    'export PGUSER="${POSTGRES_USER:-${POSTGRESQL_USERNAME:-postgres}}"; ' +
    'export PGPASSWORD="${POSTGRES_PASSWORD:-${POSTGRESQL_PASSWORD:-$POSTGRESQL_POSTGRES_PASSWORD}}"; ' +
    'for i in $(seq 1 30); do pg_isready -q && break; sleep 1; done; ' +
    'exec psql -X -q -v ON_ERROR_STOP=1 -d postgres -f -',
  mysql:
    'ROOT="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"; export MYSQL_PWD="$ROOT"; ' +
    'CLI="$(command -v mariadb || command -v mysql)"; ' +
    'for i in $(seq 1 30); do "$CLI" -uroot -e "select 1" >/dev/null 2>&1 && break; sleep 1; done; ' +
    'exec "$CLI" -uroot',
  mariadb: '',
  mongo:
    'AUTH=""; if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then ' +
    'AUTH="--username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin"; fi; ' +
    'SH="$(command -v mongosh || command -v mongo)"; exec "$SH" $AUTH --quiet',
}
SCRIPTS.mariadb = SCRIPTS.mysql

/** Instructions idempotentes : base et utilisateur créés s'ils manquent, mot de passe remplacé. */
export function provisionStatements(
  kind: 'postgres' | 'mysql' | 'mariadb' | 'mongo',
  name: string,
  password: string,
): string {
  switch (kind) {
    case 'postgres':
      return [
        `SELECT 'CREATE ROLE "${name}" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}')\\gexec`,
        `ALTER ROLE "${name}" LOGIN PASSWORD '${password}';`,
        `SELECT 'CREATE DATABASE "${name}" OWNER "${name}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')\\gexec`,
        // Par défaut, tout utilisateur peut se connecter à une nouvelle base : seul le sien le peut.
        `REVOKE ALL ON DATABASE "${name}" FROM PUBLIC;`,
        `GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${name}";`,
        '',
      ].join('\n')
    case 'mysql':
    case 'mariadb':
      return [
        `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
        `CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY '${password}';`,
        `ALTER USER '${name}'@'%' IDENTIFIED BY '${password}';`,
        `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'%';`,
        'FLUSH PRIVILEGES;',
        '',
      ].join('\n')
    case 'mongo':
      return [
        `const target = db.getSiblingDB('${name}')`,
        `const roles = [{ role: 'readWrite', db: '${name}' }]`,
        `if (target.getUser('${name}')) target.updateUser('${name}', { pwd: '${password}', roles })`,
        `else target.createUser({ user: '${name}', pwd: '${password}', roles })`,
        '',
      ].join('\n')
  }
}

/** Crée (ou met à jour) la base et l'utilisateur dédiés dans le conteneur de la base. */
export async function provisionDatabase(
  options: { runner: CommandRunner; dockerSocket: string; cwd: string },
  containerId: string,
  kind: 'postgres' | 'mysql' | 'mariadb' | 'mongo',
  name: string,
  password: string,
): Promise<void> {
  const errors: string[] = []
  const { code } = await options.runner.run(
    'docker',
    ['exec', '-i', containerId, 'sh', '-c', SCRIPTS[kind]],
    {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        DOCKER_HOST: `unix://${options.dockerSocket}`,
      },
      timeoutMs: 90_000,
      stdin: Readable.from([provisionStatements(kind, name, password)]),
      onLine: (line, stream) => {
        if (stream === 'stderr' && line.trim()) errors.push(line.trim())
      },
    },
  )
  if (code !== 0) {
    // Une erreur de syntaxe peut recopier l'instruction : le mot de passe y est masqué.
    const reason = errors.filter((line) => !/warning/i.test(line)).at(-1)
    throw new Error((reason ?? `code ${code}`).replaceAll(password, '••••••'))
  }
}
