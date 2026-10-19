import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/auth/sessions.js'
import { auditLogs, users } from '../src/db/schema.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('Conteneurs de l’hôte et nettoyage', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}

  const call = (method: 'GET' | 'POST', url: string, payload?: object, role = 'admin') =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  beforeAll(async () => {
    ctx = await setupTestApp({}, undefined, host)
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
      const { token } = await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})
      cookies[role] = `__Host-vercio_session=${token}`
    }
    host.hostList = [
      {
        id: 'a',
        name: 'vercio_site_prod-front-1',
        image: 'front@sha256:abc',
        state: 'running',
        status: 'Up 2 hours',
        health: null,
        ports: ['8080→80/tcp'],
        createdAt: new Date().toISOString(),
        composeProject: 'vercio_site_prod',
        service: 'front',
        vercio: { project: 'site', environment: 'prod' },
      },
      {
        id: 'b',
        name: 'portainer',
        image: 'portainer/portainer-ce',
        state: 'exited',
        status: 'Exited (0) 3 days ago',
        health: null,
        ports: [],
        createdAt: new Date().toISOString(),
        composeProject: null,
        service: null,
        vercio: null,
      },
    ]
    host.reclaimable = {
      'images-dangling': { count: 3, bytes: 300 },
      volumes: { count: 2, bytes: 50 },
      'build-cache': { count: -1, bytes: 0 },
    }
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('liste tous les conteneurs de l’hôte (lecteur)', async () => {
    const response = await call('GET', '/system/containers', undefined, 'viewer')
    expect(response.statusCode).toBe(200)
    expect(response.json().map((c: { name: string }) => c.name)).toEqual([
      'vercio_site_prod-front-1',
      'portainer',
    ])
  })

  it('réserve le nettoyage aux administrateurs, l’exécute et le journalise', async () => {
    expect((await call('GET', '/system/cleanup', undefined, 'viewer')).statusCode).toBe(403)
    expect(
      (await call('POST', '/system/cleanup', { targets: ['volumes'] }, 'viewer')).statusCode,
    ).toBe(403)

    const preview = (await call('GET', '/system/cleanup')).json()
    expect(preview.targets['images-dangling']).toEqual({ count: 3, bytes: 300 })
    expect(preview.targets.containers).toEqual({ count: 0, bytes: 0 })

    expect((await call('POST', '/system/cleanup', { targets: [] })).statusCode).toBe(400)
    const result = (
      await call('POST', '/system/cleanup', {
        targets: ['build-cache', 'volumes', 'images-dangling'],
      })
    ).json()
    // Images sans tag d'abord ; une erreur n'empêche pas les autres nettoyages.
    expect(host.cleanups).toEqual(['images-dangling', 'volumes'])
    expect(result.totalBytes).toBe(350)
    expect(result.targets['build-cache']).toMatchObject({ error: 'builder indisponible' })
    const [entry] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'cleanup.run'))
    expect(entry).toMatchObject({
      username: 'admin',
      target: 'images-dangling, volumes, build-cache',
    })
    expect(entry!.details).toMatchObject({ totalBytes: 350 })
  })
})
