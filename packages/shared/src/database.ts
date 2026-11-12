import { z } from 'zod'

/** Explorateur de base : services reconnus dans un environnement (PostgreSQL pour l'instant). */
export interface DatabaseServiceView {
  service: string
  engine: 'postgres'
  image: string | null
  running: boolean
}

export interface DatabaseInfo {
  name: string
  sizeBytes: number
}

export interface TableInfo {
  schema: string
  name: string
  /** Estimation de PostgreSQL (statistiques), pas un comptage exact. */
  rows: number
  sizeBytes: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
}

export interface QueryResult {
  columns: string[]
  /** null : valeur NULL. */
  rows: (string | null)[][]
  /** Résultat coupé (trop de lignes) : seules les premières sont renvoyées. */
  truncated: boolean
  durationMs: number
}

export interface TableRows extends QueryResult {
  columnInfo: ColumnInfo[]
  /** Lignes correspondant à la recherche (comptage exact). */
  total: number
  page: number
  size: number
}

/** Nom de base tel que PostgreSQL le liste (vérifié contre la liste avant usage). */
const databaseName = z.string().min(1).max(128)

export const tableRowsQuerySchema = z.object({
  database: databaseName,
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(10).max(200).default(50),
  sort: z.string().max(128).optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
  /** Recherche dans toutes les colonnes (texte). */
  q: z.string().max(200).optional(),
})
export type TableRowsQuery = z.input<typeof tableRowsQuerySchema>

export const databaseQuerySchema = z.object({
  database: databaseName,
  sql: z.string().trim().min(1, { message: 'Requête vide' }).max(20_000),
  /** false : lecture seule (transaction annulée), true : modifications enregistrées. */
  write: z.boolean().default(false),
})
export type DatabaseQueryInput = z.input<typeof databaseQuerySchema>
