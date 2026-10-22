import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { compareVersions } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner, RunOptions } from '../src/deploy/command.js'
import { users } from '../src/db/schema.js'
import { HELPER_SCRIPT, UpdateService } from '../src/updates/service.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe('compareVersions', () => {
  it('compare des versions X.Y.Z, avec ou sans « v »', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-dev', '0.2.0')).toBeNull()
  })
})

describe('Script du conteneur auxiliaire', () => {
  it('fixe VERCIO_TAG, attend un Vercio sain, sinon revient en arrière', () => {
    expect(HELPER_SCRIPT).toContain('VERCIO_TAG="$TARGET" docker compose $FLAGS pull "$SERVICE"')
    expect(HELPER_SCRIPT).toContain('up -d --no-deps "$SERVICE"')
    expect(HELPER_SCRIPT).toContain('status rolled_back')
  })
})

/** Docker simulé : export de la base de Vercio. */
class DumpDocker implements CommandRunner {
  async run(_command: string, args: string[], options: RunOptions) {
    if (args[0] === 'run' && args.at(-1)!.includes('pg_dump')) {
      options.stdout!.end('-- base de Vercio\n')
      return { code: 0 }
    }
    options.stdout?.end()
    return { code: args[0] === 'inspect' ? 1 : 0 }
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Mise à jour de Vercio', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}
  let dataDir: string
  const release = {
    version: '0.3.0',
    name: 'v0.3.0',
    notes: '### Added\n\n- Mises à jour depuis l’interface.',
    url: 'https://github.com/SitpiRajendran/Vercio/releases/tag/v0.3.0',
    publishedAt: '2026-10-22T10:00:00Z',
  }

  const call = (method: 'GET' | 'POST', url: string, payload?: object, role = 'admin') =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  beforeAll(async () => {
    ctx = await setupTestApp({}, new DumpDocker(), host, {
      version: '0.2.1',
      fetchRelease: async () => release,
    })
    dataDir = join((await import('node:os')).tmpdir(), `vercio-test-${process.pid}`)
    for (const [role, roles] of [
      ['admin', ['vercio-admin']],
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
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await ctx?.close()
  })

  it('signale la nouvelle version, et pourquoi la mise à jour est impossible', async () => {
    const checked = await call('POST', '/system/update/check')
    expect(checked.json()).toMatchObject({
      current: '0.2.1',
      latest: { version: '0.3.0' },
      available: true,
      canUpdate: false,
      reason: 'Vercio ne tourne pas dans un conteneur',
    })
    expect((await call('POST', '/system/update/check', undefined, 'viewer')).statusCode).toBe(403)
    // Lecture : tout le monde voit qu'une version est disponible.
    expect((await call('GET', '/system/update', undefined, 'viewer')).json()).toMatchObject({
      available: true,
    })

    host.self = {
      id: 'vercio',
      image: 'registry.example.com/autre:latest',
      labels: {},
      mounts: [],
    }
    expect((await call('GET', '/system/update')).json().reason).toContain('seule l’image')
  })

  it('sauvegarde, puis confie la mise à jour au conteneur auxiliaire', async () => {
    host.self = {
      id: 'vercio',
      image: 'ghcr.io/sitpirajendran/vercio:latest',
      labels: {
        'com.docker.compose.project': 'vercio',
        'com.docker.compose.service': 'vercio',
        'com.docker.compose.project.working_dir': '/opt/vercio',
        'com.docker.compose.project.config_files': '/opt/vercio/docker-compose.yml',
      },
      mounts: [
        { source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
        { source: '/srv/vercio-data', destination: dataDir },
      ],
    }
    expect((await call('GET', '/system/update')).json()).toMatchObject({
      canUpdate: true,
      reason: null,
    })
    expect((await call('POST', '/system/update', { version: '0.3.0' }, 'viewer')).statusCode).toBe(
      403,
    )
    expect((await call('POST', '/system/update', { version: '0.2.9' })).json().error).toContain(
      'pas la dernière',
    )

    const started = await call('POST', '/system/update', { version: '0.3.0' })
    expect(started.statusCode).toBe(202)
    await vi.waitFor(() => expect(host.detached).toHaveLength(1), { timeout: 5000 })
    const helper = host.detached[0]!
    expect(helper).toMatchObject({
      image: 'docker:27.5.1-cli',
      env: {
        TARGET: 'v0.3.0',
        PROJECT: 'vercio',
        SERVICE: 'vercio',
        WORKDIR: '/opt/vercio',
        FILES: '/opt/vercio/docker-compose.yml',
      },
      binds: [
        '/var/run/docker.sock:/var/run/docker.sock',
        '/opt/vercio:/opt/vercio',
        '/srv/vercio-data/updates:/vercio-updates',
      ],
    })
    // Sans sauvegarde de Vercio configurée : export dans le dossier de données.
    const files = (await readdir(join(dataDir, 'updates'))).filter((name) => name.endsWith('.gz'))
    expect(files).toHaveLength(1)
    expect(gunzipSync(await readFile(join(dataDir, 'updates', files[0]!))).toString()).toContain(
      '-- base de Vercio',
    )
    const status = (await call('GET', '/system/update')).json()
    expect(status.run).toMatchObject({ from: '0.2.1', to: '0.3.0', phase: 'pulling' })
    expect(status.run.backup).toContain('vercio-avant-v0.3.0')

    // Étape écrite par l'auxiliaire, lue pendant que l'ancien Vercio tourne encore.
    await writeFile(join(dataDir, 'updates', 'helper.json'), '{"phase":"restarting","message":""}')
    expect((await call('GET', '/system/update')).json().run.phase).toBe('restarting')
    expect((await call('POST', '/system/update', { version: '0.3.0' })).json().error).toContain(
      'déjà en cours',
    )
  })

  it('donne les infos techniques aux administrateurs, sans secret', async () => {
    expect((await call('GET', '/system/info', undefined, 'viewer')).statusCode).toBe(403)
    const info = (await call('GET', '/system/info')).json()
    expect(info.vercio).toMatchObject({ publicUrl: ORIGIN, localAuth: true, sso: false })
    expect(info.vercio.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(info.database).toMatchObject({
      error: null,
      server: expect.stringMatching(/^PostgreSQL /),
    })
    expect(info.database.migrations).toBeGreaterThan(10)
    expect(info.counts).toMatchObject({ users: expect.any(Number) })
    expect(info.container).toMatchObject({ image: 'ghcr.io/sitpirajendran/vercio:latest' })
    // L'adresse de la base n'est donnée qu'en morceaux, sans mot de passe.
    expect(JSON.stringify(info)).not.toContain(TEST_DATABASE_URL!)
    expect(Object.keys(info.database)).not.toContain('password')
  })

  it('au redémarrage : réussite si la nouvelle version tourne, sinon le compte rendu', async () => {
    const service = (version: string) =>
      new UpdateService({
        db: ctx.db,
        host,
        backups: ctx.app.backups,
        dataDir,
        version,
        enabled: true,
        log: ctx.app.log,
      })
    const done = service('0.3.0')
    await done.recover()
    expect((await done.status()).run).toMatchObject({ phase: 'done' })

    // Nouvelle mise à jour simulée, revenue en arrière.
    const run = JSON.parse(await readFile(join(dataDir, 'updates', 'run.json'), 'utf8'))
    await writeFile(
      join(dataDir, 'updates', 'run.json'),
      JSON.stringify({ ...run, phase: 'restarting', finishedAt: null }),
    )
    await writeFile(
      join(dataDir, 'updates', 'helper.json'),
      '{"phase":"rolled_back","message":"La version v0.3.0 n’a pas démarré"}',
    )
    const rolledBack = service('0.2.1')
    await rolledBack.recover()
    expect((await rolledBack.status()).run).toMatchObject({
      phase: 'rolled_back',
      message: 'La version v0.3.0 n’a pas démarré',
    })
    await rm(join(dataDir, 'updates'), { recursive: true, force: true })
  })
})

describe('Emplacement des dossiers de sauvegarde sur le serveur', () => {
  it('traduit le chemin par le montage le plus précis, null hors montage', async () => {
    const { hostLocation } = await import('../src/routes/backups.js')
    const self = {
      id: 'vercio',
      image: 'x',
      labels: {},
      mounts: [
        { source: '/var/lib/vercio', destination: '/var/lib/vercio' },
        { source: '/mnt/nas', destination: '/var/lib/vercio/nas' },
      ],
    }
    expect(hostLocation('/var/lib/vercio/sauvegardes', self)).toBe('/var/lib/vercio/sauvegardes')
    expect(hostLocation('/var/lib/vercio/nas/vercio', self)).toBe('/mnt/nas/vercio')
    expect(hostLocation('/backups', self)).toBeNull()
    expect(hostLocation('/var/lib/vercio-autre', self)).toBeNull()
    // Hors conteneur : le chemin est déjà celui du serveur.
    expect(hostLocation('/srv/sauvegardes', null)).toBe('/srv/sauvegardes')
  })
})
