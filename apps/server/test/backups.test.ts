import { spawn } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { gunzipSync } from 'node:zlib'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BackupDestinationView, BackupPlanPage, BackupView, ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { decryptStream, encryptStream } from '../src/backups/crypto.js'
import { databaseEngine } from '../src/backups/databases.js'
import { nextRun } from '../src/backups/service.js'
import type { BackupStore } from '../src/backups/store.js'
import { backupPlans, users } from '../src/db/schema.js'
import type { CommandRunner } from '../src/deploy/command.js'
import type { ContainerDetails } from '../src/docker/host-driver.js'
import { FakeHost, ORIGIN, type FakeContainer, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const DUMP = 'CREATE TABLE commandes (id int); -- export de test assez long\n'.repeat(5)

/** Stockage S3 en mémoire. */
class MemoryStore implements BackupStore {
  files = new Map<string, Buffer>()
  location = 's3://test'
  async put(key: string, data: Readable) {
    const content = await buffer(data)
    this.files.set(key, content)
    return content.length
  }
  async get(key: string) {
    const content = this.files.get(key)
    if (!content) throw new Error('absent')
    return Readable.from([content])
  }
  async removeFolder(folder: string) {
    for (const key of [...this.files.keys()])
      if (key.startsWith(`${folder}/`)) this.files.delete(key)
  }
  async check() {}
}

describe('Chiffrement des sauvegardes', () => {
  it('relit le fichier avec la bonne phrase et refuse une phrase fausse', async () => {
    const data = Buffer.alloc(200_000, 'x')
    const encrypted = await buffer(
      Readable.from([data]).pipe(await encryptStream('phrase-secrete-1')),
    )
    expect(encrypted.subarray(0, 4).toString()).toBe('VRCB')
    const plain = await buffer(Readable.from([encrypted]).pipe(decryptStream('phrase-secrete-1')))
    expect(plain.equals(data)).toBe(true)
    await expect(
      buffer(Readable.from([encrypted]).pipe(decryptStream('mauvaise-phrase'))),
    ).rejects.toThrow(/incorrecte/)
    // Fichier vide : chiffré puis relu à l'identique.
    const empty = await buffer(Readable.from([]).pipe(await encryptStream('phrase-secrete-1')))
    expect(
      (await buffer(Readable.from([empty]).pipe(decryptStream('phrase-secrete-1')))).length,
    ).toBe(0)
  })

  it('reconnaît les bases et calcule la prochaine exécution', () => {
    expect(databaseEngine('postgres:16-alpine')).toBe('postgres')
    expect(databaseEngine('bitnami/postgresql:15')).toBe('postgres')
    expect(databaseEngine('registry.exemple.fr/mariadb:11@sha256:abc')).toBe('mariadb')
    expect(databaseEngine('mysql:8')).toBe('mysql')
    expect(databaseEngine('mongo:7')).toBe('mongo')
    expect(databaseEngine('nginx:1.27')).toBeNull()
    const from = new Date(2026, 9, 19, 10, 0)
    expect(nextRun({ kind: 'daily', time: '03:00' }, from)).toEqual(new Date(2026, 9, 20, 3, 0))
    expect(nextRun({ kind: 'daily', time: '12:30' }, from)).toEqual(new Date(2026, 9, 19, 12, 30))
    expect(nextRun({ kind: 'interval', hours: 6 }, from)).toEqual(new Date(2026, 9, 19, 16, 0))
  })
})

describe.skipIf(!TEST_DATABASE_URL)('Sauvegardes', () => {
  const host = new FakeHost()
  const s3 = new MemoryStore()
  const folder = join(tmpdir(), `vercio-sauvegardes-${process.pid}`)
  const calls: { args: string[]; stdin: string | null }[] = []
  let failVolumes = false
  let dumpUrl: string | null = null
  let vercioDump = DUMP
  const runner: CommandRunner = {
    async run(_command, args, options) {
      const stdin = options.stdin ? (await buffer(options.stdin)).toString() : null
      calls.push({ args, stdin })
      if (args[0] === 'run' && args.includes('czf')) {
        if (failVolumes) {
          options.onLine('docker: volume introuvable', 'stderr')
          options.stdout?.end()
          return { code: 125 }
        }
        const volume = args[args.indexOf('-v') + 1]!.split(':')[0]
        options.stdout!.end(`contenu de ${volume}`)
        return { code: 0 }
      }
      if (args[0] === 'exec' && !args.includes('-i')) {
        options.stdout!.end(DUMP)
        return { code: 0 }
      }
      // Vercio hors conteneur dans les tests : pas d'inspection de lui-même.
      if (args[0] === 'inspect') return { code: 1 }
      // Import de la base de Vercio : vrai psql sur la base de test.
      if (args[0] === 'run' && args.at(-1)!.includes('psql')) {
        const child = spawn(
          'psql',
          ['-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', options.env.VERCIO_DUMP_URL!],
          {
            stdio: ['pipe', 'ignore', 'pipe'],
          },
        )
        child.stdin.end(stdin)
        child.stderr.on('data', (chunk: Buffer) => options.onLine(chunk.toString(), 'stderr'))
        return {
          code: await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1))),
        }
      }
      if (args[0] === 'run' && args.at(-1)!.includes('pg_dump')) {
        dumpUrl = options.env.VERCIO_DUMP_URL ?? null
        options.stdout!.end(`-- base de Vercio\n${vercioDump}`)
        return { code: 0 }
      }
      options.stdout?.end()
      return { code: 0 }
    },
  }
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}
  let site: ProjectView
  let base: string

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    role = 'admin',
  ) =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  const container = (id: string, service: string, image: string): FakeContainer => ({
    id,
    name: `vercio_site_prod-${service}-1`,
    service,
    image,
    state: 'running',
    status: 'Up',
    health: null,
    createdAt: new Date().toISOString(),
    ports: [],
  })

  const details = (id: string, volume: string) =>
    ({
      id,
      mounts: [{ type: 'volume', source: volume, destination: '/data', readOnly: false }],
    }) as unknown as ContainerDetails

  const run = async (role = 'deployer') => {
    const response = await call('POST', base, undefined, role)
    expect(response.statusCode).toBe(202)
    await ctx.app.backups.idle()
    const page = (await call('GET', base)).json() as BackupPlanPage & { backups: BackupView[] }
    return page.backups.find((item) => item.id === response.json().id)!
  }

  beforeAll(async () => {
    ctx = await setupTestApp({}, runner, host)
    // Le S3 simulé remplace le vrai client ; le dossier local reste réel.
    const original = ctx.app.backups.store.bind(ctx.app.backups)
    ctx.app.backups.store = (row) => (row.type === 's3' ? s3 : original(row))
    for (const [role, roles] of [
      ['admin', ['vercio-admin']],
      ['deployer', ['vercio-deployer']],
      ['viewer', ['vercio-viewer']],
    ] as const) {
      const [user] = await ctx.db
        .insert(users)
        .values({
          provider: 'oidc',
          subject: role,
          username: role,
          displayName: role,
          roles: [...roles],
        })
        .returning()
      cookies[role] =
        `__Host-vercio_session=${(await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})).token}`
    }
    const created = await call('POST', '/projects', {
      name: 'Site',
      slug: 'site',
      type: 'compose',
      compose: { source: 'inline', content: 'services:\n  web:\n    image: nginx\n' },
      sources: [],
      trackedServices: [],
      environments: [{ name: 'Production', slug: 'prod', sources: [] }],
    })
    site = created.json()
    base = `/projects/${site.id}/environments/${site.environments[0]!.id}/backups`
    host.containers.set('vercio_site_prod', [
      container('c-web', 'web', 'nginx'),
      container('c-db', 'db', 'postgres:16'),
    ])
    host.details.set('c-web', details('c-web', 'vercio_site_prod_uploads'))
    host.details.set('c-db', details('c-db', 'vercio_site_prod_pgdata'))
  })

  afterAll(async () => {
    await ctx?.close()
    await rm(folder, { recursive: true, force: true })
  })

  let local: BackupDestinationView

  it('gère les destinations sans jamais renvoyer les secrets', async () => {
    const input = {
      type: 'local',
      name: 'Disque',
      config: { path: folder },
      passphrase: 'phrase-de-test-1',
    }
    expect(
      (await call('POST', '/settings/backup-destinations', input, 'deployer')).statusCode,
    ).toBe(403)
    expect(
      (
        await call('POST', '/settings/backup-destinations', {
          ...input,
          config: { path: 'relatif' },
        })
      ).statusCode,
    ).toBe(400)
    const test = await call('POST', '/settings/backup-destinations/test', input)
    expect(test.json()).toMatchObject({ ok: true })
    const created = await call('POST', '/settings/backup-destinations', input)
    expect(created.statusCode).toBe(201)
    local = created.json()
    expect(local).toMatchObject({ name: 'Disque', encrypted: true, location: folder })
    expect(created.body).not.toContain('phrase-de-test-1')

    const s3Input = {
      type: 's3',
      name: 'Objet',
      config: { endpoint: 'https://s3.exemple.fr', bucket: 'sauvegardes', prefix: '/vercio/' },
    }
    expect((await call('POST', '/settings/backup-destinations', s3Input)).statusCode).toBe(409)
    const s3Created = await call('POST', '/settings/backup-destinations', {
      ...s3Input,
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'cle-tres-secrete' },
    })
    expect(s3Created.statusCode).toBe(201)
    expect(s3Created.json()).toMatchObject({
      location: 's3://sauvegardes/vercio (s3.exemple.fr)',
      encrypted: false,
      hasCredentials: true,
    })
    expect(s3Created.body).not.toContain('cle-tres-secrete')
    // Modification sans ressaisir les clés : gardées.
    const renamed = await call('PUT', `/settings/backup-destinations/${s3Created.json().id}`, {
      ...s3Input,
      name: 'Objet 2',
    })
    expect(renamed.json()).toMatchObject({ name: 'Objet 2', hasCredentials: true })
    // Autre bucket sans ressaisir les clés : refusé (elles partiraient ailleurs).
    const moved = await call('PUT', `/settings/backup-destinations/${s3Created.json().id}`, {
      ...s3Input,
      name: 'Objet 2',
      config: { ...s3Input.config, bucket: 'autre-bucket' },
    })
    expect(moved.statusCode).toBe(409)
    expect(moved.json().error).toContain('Ressaisissez les clés')
  })

  it('propose les bases et écarte par défaut leurs volumes de données', async () => {
    const page = (await call('GET', base, undefined, 'viewer')).json() as BackupPlanPage
    expect(page.plan).toBeNull()
    expect(page.candidates).toEqual([
      expect.objectContaining({ key: 'database:db', engine: 'postgres', includedByDefault: true }),
      expect.objectContaining({
        key: 'volume:vercio_site_prod_pgdata',
        coveredBy: 'db',
        includedByDefault: false,
      }),
      expect.objectContaining({ key: 'volume:vercio_site_prod_uploads', includedByDefault: true }),
    ])
    expect((await call('POST', base, undefined, 'deployer')).statusCode).toBe(409)
  })

  it('sauvegarde, chiffre et relit les fichiers', async () => {
    const plan = await call('PUT', `${base}/plan`, {
      enabled: true,
      destinationId: local.id,
      schedule: { kind: 'daily', time: '03:00' },
      keep: 2,
    })
    expect(plan.statusCode).toBe(200)
    expect(plan.json()).toMatchObject({ enabled: true, keep: 2, destination: { encrypted: true } })
    expect(plan.json().nextRunAt).not.toBeNull()

    const backup = await run()
    expect(backup).toMatchObject({
      status: 'succeeded',
      encrypted: true,
      trigger: 'manual',
      username: 'deployer',
    })
    expect(backup.items.map((item) => [item.key, item.file])).toEqual([
      ['database:db', 'databases/db.sql.gz.enc'],
      ['volume:vercio_site_prod_uploads', 'volumes/vercio_site_prod_uploads.tar.gz.enc'],
    ])
    expect(calls.find((call) => call.args[0] === 'exec')!.args).toEqual([
      'exec',
      'c-db',
      'sh',
      '-c',
      expect.stringContaining('pg_dumpall'),
    ])
    const dir = join(folder, backup.location)
    expect(await readdir(join(dir, 'databases'))).toEqual(['db.sql.gz.enc'])
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ project: 'site', environment: 'prod', encrypted: true })
    const raw = await readFile(join(dir, 'databases/db.sql.gz.enc'))
    expect(raw.subarray(0, 4).toString()).toBe('VRCB')
    const plain = await buffer(Readable.from([raw]).pipe(decryptStream('phrase-de-test-1')))
    expect(gunzipSync(plain).toString()).toBe(DUMP)

    // Téléchargement : déchiffré, réservé aux administrateurs.
    const url = `${base}/${backup.id}/download?item=${encodeURIComponent('database:db')}`
    expect((await call('GET', url, undefined, 'deployer')).statusCode).toBe(403)
    const download = await call('GET', url)
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain('site-prod-')
    expect(gunzipSync(download.rawPayload).toString()).toBe(DUMP)
  })

  it('signale un élément en échec et applique la rétention', async () => {
    failVolumes = true
    const partial = await run()
    failVolumes = false
    expect(partial).toMatchObject({ status: 'partial', error: '1 élément(s) en échec' })
    expect(partial.items.find((item) => item.kind === 'volume')).toMatchObject({
      status: 'failed',
      error: 'docker: volume introuvable',
    })
    const third = await run()
    expect(third.status).toBe('succeeded')
    const page = (await call('GET', base)).json() as { backups: BackupView[] }
    // keep: 2 → la première sauvegarde a disparu de l'historique et du disque.
    expect(page.backups.map((item) => item.id)).toEqual([third.id, partial.id])
    expect(await readdir(join(folder, 'site', 'prod'))).toHaveLength(2)
  })

  it('restaure après confirmation, en arrêtant puis relançant l’application', async () => {
    const page = (await call('GET', base)).json() as { backups: BackupView[] }
    const backup = page.backups[0]!
    const url = `${base}/${backup.id}/restore`
    const items = ['database:db', 'volume:vercio_site_prod_uploads']
    expect((await call('POST', url, { items, confirm: 'Site' }, 'deployer')).statusCode).toBe(403)
    expect((await call('POST', url, { items, confirm: 'site' })).statusCode).toBe(400)
    calls.length = 0
    host.actions.length = 0
    const restore = await call('POST', url, { items, confirm: 'Site' })
    expect(restore.statusCode).toBe(202)
    await ctx.app.backups.idle()

    const detail = (await call('GET', `${base}/${backup.id}`)).json()
    expect(detail.lastRestore).toMatchObject({ status: 'succeeded', username: 'admin' })
    expect(detail.restoreLogs.join('\n')).toContain('Restauration terminée')
    // Le web est arrêté pendant l'opération ; la base reste en marche pour l'import.
    expect(host.actions).toEqual([
      { id: 'c-web', action: 'stop' },
      { id: 'c-web', action: 'start' },
    ])
    const activity = (await call('GET', '/events/activity?kind=backup', undefined, 'viewer')).json()
    expect(activity[0]).toMatchObject({
      kind: 'backup',
      backup: { operation: 'restore', status: 'succeeded', username: 'admin' },
    })
    expect(
      activity.filter(
        (item: { backup: { operation: string } }) => item.backup.operation === 'backup',
      ),
    ).toHaveLength(2)
    const volume = calls.find((call) => call.args[0] === 'run')!
    expect(volume.args).toContain('vercio_site_prod_uploads:/data')
    expect(volume.stdin).toBe('contenu de vercio_site_prod_uploads')
    const database = calls.find((call) => call.args[0] === 'exec')!
    expect(database.args.slice(0, 3)).toEqual(['exec', '-i', 'c-db'])
    expect(database.stdin).toBe(DUMP)
  })

  it('refuse de restaurer un fichier modifié dans la destination', async () => {
    const page = (await call('GET', base)).json() as { backups: BackupView[] }
    const backup = page.backups[0]!
    const item = backup.items.find((entry) => entry.kind === 'volume')!
    // Quelqu'un remplace le fichier dans le dossier (ou le bucket) de sauvegarde.
    await writeFile(join(folder, backup.location, item.file!), 'contenu piégé')
    calls.length = 0
    host.actions.length = 0
    const restore = await call('POST', `${base}/${backup.id}/restore`, {
      items: [item.key],
      confirm: 'Site',
    })
    expect(restore.statusCode).toBe(202)
    await ctx.app.backups.idle()
    const detail = (await call('GET', `${base}/${backup.id}`)).json()
    expect(detail.lastRestore).toMatchObject({ status: 'failed' })
    expect(detail.lastRestore.error).toContain('modifié dans la destination')
    // Rien n'a été touché : ni arrêt, ni écriture dans le volume.
    expect(host.actions).toEqual([])
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  it('lance les sauvegardes planifiées et envoie vers S3 en clair', async () => {
    const destinations = (
      await call('GET', '/settings/backup-destinations')
    ).json() as BackupDestinationView[]
    const objet = destinations.find((item) => item.type === 's3')!
    expect((await call('DELETE', `/settings/backup-destinations/${local.id}`)).statusCode).toBe(409)
    await call('PUT', `${base}/plan`, {
      enabled: true,
      destinationId: objet.id,
      schedule: { kind: 'interval', hours: 6 },
      keep: 5,
      selection: { 'volume:vercio_site_prod_uploads': false },
    })
    await ctx.db.update(backupPlans).set({ nextRunAt: new Date(Date.now() - 1000) })
    await ctx.app.backups.tick()
    await ctx.app.backups.idle()
    const page = (await call('GET', base)).json() as {
      backups: BackupView[]
      plan: { nextRunAt: string }
    }
    const scheduled = page.backups[0]!
    expect(scheduled).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      encrypted: false,
      username: null,
    })
    expect(scheduled.items.map((item) => item.key)).toEqual(['database:db'])
    expect(new Date(page.plan.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 5 * 3_600_000)
    const key = `${scheduled.location}/databases/db.sql.gz`
    expect(gunzipSync(s3.files.get(key)!).toString()).toBe(DUMP)
    expect(s3.files.has(`${scheduled.location}/manifest.json`)).toBe(true)

    const overview = (await call('GET', '/overview', undefined, 'viewer')).json()
    expect(overview.projects[0].environments[0].lastBackup).toMatchObject({ status: 'succeeded' })

    // Suppression : retirée de l'historique et du stockage.
    expect((await call('DELETE', `${base}/${scheduled.id}`)).statusCode).toBe(204)
    expect(s3.files.has(key)).toBe(false)
    const [plan] = await ctx.db
      .select()
      .from(backupPlans)
      .where(eq(backupPlans.environmentId, site.environments[0]!.id))
    expect(plan!.selection).toEqual({ 'volume:vercio_site_prod_uploads': false })
  })

  it('sauvegarde la base de Vercio lui-même (administrateurs)', async () => {
    const url = '/settings/backups/vercio'
    expect((await call('GET', url, undefined, 'deployer')).statusCode).toBe(403)
    expect((await call('POST', url)).statusCode).toBe(409)
    const plan = await call('PUT', `${url}/plan`, {
      enabled: true,
      destinationId: local.id,
      schedule: { kind: 'daily', time: '02:30' },
      keep: 3,
    })
    expect(plan.json()).toMatchObject({ enabled: true, keep: 3, destination: { id: local.id } })
    // Destination utilisée par Vercio seul (le projet est passé sur S3) : comptée, non supprimable.
    const destinations = (await call('GET', '/settings/backup-destinations')).json()
    expect(destinations.find((item: { id: string }) => item.id === local.id).plans).toBe(1)

    expect((await call('DELETE', `/settings/backup-destinations/${local.id}`)).statusCode).toBe(409)
    calls.length = 0
    const run = await call('POST', url)
    expect(run.statusCode).toBe(202)
    await ctx.app.backups.idle()
    const page = (await call('GET', url)).json()
    expect(page.backups).toHaveLength(1)
    const backup = page.backups[0]
    expect(backup).toMatchObject({ status: 'succeeded', encrypted: true, username: 'admin' })
    expect(backup.location).toMatch(/^_vercio\//)
    const dump = calls.find((item) => item.args.at(-1)?.includes('pg_dump'))!
    expect(dump.args).toEqual(
      expect.arrayContaining(['--network', 'host', '-e', 'VERCIO_DUMP_URL']),
    )
    expect(dump.args.join(' ')).not.toContain(TEST_DATABASE_URL!)
    expect(dumpUrl).toBe(TEST_DATABASE_URL)

    const download = await call(
      'GET',
      `${url}/${backup.id}/download?item=${encodeURIComponent('database:vercio')}`,
    )
    expect(gunzipSync(download.rawPayload).toString()).toContain('-- base de Vercio')
    // Hors des environnements : ni dans un projet, ni restaurable depuis l'interface.
    expect(
      (await call('GET', base))
        .json()
        .backups.some((item: { id: string }) => item.id === backup.id),
    ).toBe(false)
    expect((await call('DELETE', `${url}/${backup.id}`)).statusCode).toBe(204)
    expect((await call('DELETE', `${url}/plan`)).statusCode).toBe(204)
  })

  it('restaure la base de Vercio : sauvegarde de sécurité, tout ou rien, puis redémarrage', async () => {
    const url = '/settings/backups/vercio'
    await call('PUT', `${url}/plan`, {
      enabled: false,
      destinationId: local.id,
      schedule: { kind: 'daily', time: '02:30' },
      keep: 5,
    })
    const backupOf = async (dump: string) => {
      vercioDump = dump
      await call('POST', url)
      await ctx.app.backups.idle()
      return (await call('GET', url)).json().backups[0] as BackupView
    }
    const restore = async (id: string, confirm = 'vercio', role = 'admin') => {
      const response = await call('POST', `${url}/${id}/restore`, { confirm }, role)
      await ctx.app.backups.idle()
      return response
    }

    // Import en erreur : transaction annulée, base intacte, pas de redémarrage.
    const broken = await backupOf('insert into table_absente values (1);')
    expect((await restore(broken.id, 'vercio', 'deployer')).statusCode).toBe(403)
    expect((await restore(broken.id, 'oui')).statusCode).toBe(400)
    expect((await restore(broken.id)).statusCode).toBe(202)
    let page = (await call('GET', url)).json()
    expect(page.restore).toMatchObject({ backupId: broken.id, status: 'failed' })
    expect(page.restore.error).toMatch(/import refusé, base inchangée.*table_absente/)
    expect(ctx.restarts.count).toBe(0)

    // Import réussi : la base reçoit la sauvegarde, l'historique est gardé, Vercio redémarre.
    const good = await backupOf(
      "insert into audit_logs (action, success) values ('marqueur-restauration', true);",
    )
    const before = (await call('GET', url)).json().backups.length
    expect((await restore(good.id)).statusCode).toBe(202)
    expect(ctx.restarts.count).toBe(1)
    page = (await call('GET', url)).json()
    expect(page.restore).toMatchObject({ status: 'running' })
    expect(page.restore.logs.join('\n')).toContain('sauvegarde de sécurité')
    // Une sauvegarde de sécurité de plus, et l'historique d'avant toujours là.
    expect(page.backups).toHaveLength(before + 1)
    const audit = await ctx.db.execute(
      sql`select count(*)::int as n from audit_logs where action = 'marqueur-restauration'`,
    )
    expect((audit as unknown as { n: number }[])[0]!.n).toBe(1)
  })
})
