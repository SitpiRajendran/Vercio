import type { ColumnInfo, QueryResult } from '@vercio/shared'
import type { CommandRunner } from '../deploy/command.js'

/** Lignes renvoyées au plus par une requête de la console. */
export const MAX_ROWS = 1000
/** Délai maximal d'une requête, côté PostgreSQL. */
const STATEMENT_TIMEOUT = '15s'
/** Marque d'une valeur NULL dans la sortie CSV de psql (distincte d'une chaîne vide). */
const NULL_MARK = '␀NULL␀'

export class QueryError extends Error {}

/** `"nom"` : identifiant PostgreSQL entre guillemets (guillemets internes doublés). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** `'texte'` : littéral PostgreSQL (standard_conforming_strings, apostrophes doublées). */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** CSV de psql (`--csv`) : guillemets, retours à la ligne dans les valeurs. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Requêtes lancées dans le conteneur PostgreSQL avec ses identifiants d'administration (ceux de
 * l'image). Chaque instruction est un `-c` : psql l'envoie telle quelle au serveur, sans
 * interpréter de commande interne (`\!` et autres ne s'exécutent pas).
 */
const SCRIPT =
  'export PGUSER="${POSTGRES_USER:-${POSTGRESQL_USERNAME:-postgres}}"; ' +
  'export PGPASSWORD="${POSTGRES_PASSWORD:-${POSTGRESQL_PASSWORD:-$POSTGRESQL_POSTGRES_PASSWORD}}"; ' +
  `DB="$1"; shift; exec psql -X -q --csv -v ON_ERROR_STOP=1 -P null='${NULL_MARK}' -d "$DB" "$@"`

export interface ExplorerOptions {
  runner: CommandRunner
  dockerSocket: string
  cwd: string
}

/**
 * Exécute du SQL dans le conteneur. Par défaut en lecture seule : la session refuse les
 * écritures et la transaction est annulée. C'est un garde-fou contre les erreurs, pas une
 * frontière de sécurité (un administrateur a aussi le terminal du conteneur).
 */
export async function runSql(
  options: ExplorerOptions,
  containerId: string,
  database: string,
  sql: string,
  { write = false, maxRows = MAX_ROWS }: { write?: boolean; maxRows?: number } = {},
): Promise<QueryResult> {
  const body = sql.trim().replace(/;+\s*$/, '')
  // Une option -c qui commence par « \ » serait une commande interne de psql (\! lance une
  // commande système) : refusée. Ailleurs dans le texte, le serveur la reçoit comme du SQL.
  if (body.startsWith('\\')) {
    throw new QueryError(
      'Les commandes de psql (\\d, \\! …) ne sont pas acceptées : écrivez du SQL',
    )
  }
  // Lecture seule : la session elle-même refuse les écritures, même après un COMMIT dans la requête.
  const statements = [
    `SET statement_timeout = '${STATEMENT_TIMEOUT}'`,
    ...(write ? ['BEGIN'] : ['SET default_transaction_read_only = on', 'BEGIN READ ONLY']),
    body,
    write ? 'COMMIT' : 'ROLLBACK',
  ]
  const out: string[] = []
  const errors: string[] = []
  let lines = 0
  const started = Date.now()
  const { code } = await options.runner.run(
    'docker',
    [
      'exec',
      containerId,
      'sh',
      '-c',
      SCRIPT,
      'sh',
      database,
      ...statements.flatMap((statement) => ['-c', statement]),
    ],
    {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        DOCKER_HOST: `unix://${options.dockerSocket}`,
      },
      timeoutMs: 30_000,
      onLine: (line, stream) => {
        if (stream === 'stderr') {
          if (line.trim()) errors.push(line.trim())
        } else if (lines++ <= maxRows + 50) {
          // Marge : une valeur peut tenir sur plusieurs lignes ; le compte exact se fait au parsing.
          out.push(line)
        }
      },
    },
  )
  const durationMs = Date.now() - started
  if (code !== 0) {
    const message = errors.find((line) => /^(psql:.*)?ERROR:/.test(line)) ?? errors.at(-1)
    throw new QueryError(
      (message ?? `code ${code}`).replace(/^psql:[^:]*:\d+:\s*/, '').replace(/^ERROR:\s*/, ''),
    )
  }
  const [header, ...rows] = parseCsv(out.join('\n'))
  const truncated = rows.length > maxRows || lines > maxRows + 51
  return {
    columns: header ?? [],
    rows: rows
      .slice(0, maxRows)
      .map((row) => row.map((value) => (value === NULL_MARK ? null : value))),
    truncated,
    durationMs,
  }
}

/** Colonnes d'une table, avec la clé primaire. */
export function columnsQuery(schema: string, table: string): string {
  return `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable,
    COALESCE(a.attnum = ANY(i.indkey), false) AS primary_key
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
  WHERE n.nspname = ${quoteLiteral(schema)} AND c.relname = ${quoteLiteral(table)}
    AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`
}

export function toColumns(result: QueryResult): ColumnInfo[] {
  return result.rows.map(([name, type, nullable, primaryKey]) => ({
    name: name ?? '',
    type: type ?? '',
    nullable: nullable === 't',
    primaryKey: primaryKey === 't',
  }))
}

export const DATABASES_QUERY = `SELECT datname, pg_database_size(datname)
  FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`

export const TABLES_QUERY = `SELECT n.nspname, c.relname, GREATEST(c.reltuples, 0)::bigint,
    pg_total_relation_size(c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname`

/**
 * Lignes d'une table : identifiants déjà vérifiés contre la liste des colonnes ; la recherche
 * porte sur la ligne entière convertie en texte.
 */
export function rowsQueries(input: {
  schema: string
  table: string
  sort: string | null
  dir: 'asc' | 'desc'
  q: string | null
  page: number
  size: number
}) {
  const from = `${quoteIdent(input.schema)}.${quoteIdent(input.table)} AS t`
  const where = input.q ? ` WHERE t::text ILIKE ${quoteLiteral(`%${input.q}%`)}` : ''
  const order = input.sort
    ? ` ORDER BY ${quoteIdent(input.sort)} ${input.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
    : ''
  return {
    rows: `SELECT t.* FROM ${from}${where}${order} LIMIT ${input.size} OFFSET ${(input.page - 1) * input.size}`,
    count: `SELECT count(*) FROM ${from}${where}`,
  }
}
