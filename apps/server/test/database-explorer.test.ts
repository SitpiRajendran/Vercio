import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/deploy/command.js'
import {
  parseCsv,
  quoteIdent,
  quoteLiteral,
  rowsQueries,
  runSql,
} from '../src/database/explorer.js'

/** psql simulé : renvoie le CSV donné et garde les arguments reçus. */
function fakePsql(csv: string, code = 0, stderr: string[] = []) {
  const calls: string[][] = []
  const runner: CommandRunner = {
    async run(_command, args, options) {
      calls.push(args)
      for (const line of csv.split('\n')) options.onLine(line, 'stdout')
      for (const line of stderr) options.onLine(line, 'stderr')
      return { code }
    },
  }
  return { calls, options: { runner, dockerSocket: '/var/run/docker.sock', cwd: '/tmp' } }
}

describe('Explorateur de base', () => {
  it('lit le CSV de psql : virgules, guillemets et retours à la ligne dans les valeurs', () => {
    expect(parseCsv('id,nom\n1,"a, b"\n2,"il dit ""oui"""\n3,"ligne1\nligne2"\n')).toEqual([
      ['id', 'nom'],
      ['1', 'a, b'],
      ['2', 'il dit "oui"'],
      ['3', 'ligne1\nligne2'],
    ])
  })

  it('protège les noms et les valeurs dans le SQL généré', () => {
    expect(quoteIdent('ma "table"')).toBe('"ma ""table"""')
    expect(quoteLiteral("l'été")).toBe("'l''été'")
    const sql = rowsQueries({
      schema: 'public',
      table: 'clients',
      sort: 'nom',
      dir: 'desc',
      q: "o'; drop table x; --",
      page: 3,
      size: 50,
    })
    expect(sql.rows).toBe(
      `SELECT t.* FROM "public"."clients" AS t WHERE t::text ILIKE '%o''; drop table x; --%' ORDER BY "nom" DESC NULLS LAST LIMIT 50 OFFSET 100`,
    )
    expect(sql.count).toContain('SELECT count(*) FROM "public"."clients" AS t WHERE')
  })

  it('lecture seule par défaut, chaque instruction en -c, NULL distinct de la chaîne vide', async () => {
    const psql = fakePsql('id,note\n1,␀NULL␀\n2,\n')
    const result = await runSql(psql.options, 'abc', 'app', 'select id, note from t;')
    expect(result.rows).toEqual([
      ['1', null],
      ['2', ''],
    ])
    const args = psql.calls[0]!
    expect(args.slice(0, 2)).toEqual(['exec', 'abc'])
    // Après le nom de la base : les instructions, chacune précédée de -c.
    const after = args.slice(args.indexOf('app') + 1)
    const statements = after.filter((_, i) => after[i - 1] === '-c')
    expect(statements).toEqual([
      "SET statement_timeout = '15s'",
      'SET default_transaction_read_only = on',
      'BEGIN READ ONLY',
      'select id, note from t',
      'ROLLBACK',
    ])
  })

  it('refuse les commandes internes de psql', async () => {
    const psql = fakePsql('')
    await expect(runSql(psql.options, 'abc', 'app', '  \\! id')).rejects.toThrow(
      /commandes de psql/,
    )
    expect(psql.calls).toHaveLength(0)
  })

  it('renvoie l’erreur de PostgreSQL, et coupe les résultats trop longs', async () => {
    const failing = fakePsql('', 3, ['psql:<stdin>:1: ERROR:  relation "x" does not exist'])
    await expect(runSql(failing.options, 'abc', 'app', 'select * from x')).rejects.toThrow(
      'relation "x" does not exist',
    )
    const many = fakePsql(['g', ...Array.from({ length: 30 }, (_, i) => String(i))].join('\n'))
    const result = await runSql(many.options, 'abc', 'app', 'select g', { maxRows: 10 })
    expect(result.rows).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })
})
