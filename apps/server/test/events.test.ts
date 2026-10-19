import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActivityItem, AuditEntryView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import {
  deployments,
  environments,
  hosts,
  projects,
  users,
  webhookEvents,
} from '../src/db/schema.js'
import { audit } from '../src/lib/audit.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('Évènements et journal d’audit', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}

  const get = (url: string, role = 'admin') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
    })

  beforeAll(async () => {
    ctx = await setupTestApp()
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
    const [host] = await ctx.db.select().from(hosts).limit(1)
    const [site, blog] = await ctx.db
      .insert(projects)
      .values([
        { name: 'Site', slug: 'site', type: 'compose' },
        { name: 'Blog', slug: 'blog', type: 'compose' },
      ])
      .returning()
    const [siteProd, blogProd] = await ctx.db
      .insert(environments)
      .values([
        { projectId: site!.id, hostId: host!.id, name: 'Production', slug: 'prod' },
        { projectId: blog!.id, hostId: host!.id, name: 'Production', slug: 'prod' },
      ])
      .returning()
    const at = (minutes: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + minutes * 60_000)
    await ctx.db.insert(deployments).values([
      {
        environmentId: siteProd!.id,
        trigger: 'user',
        status: 'succeeded',
        versions: { a: { branch: 'main', ref: 'v1.2', tag: 'v1.2' } },
        createdAt: at(0),
      },
      {
        environmentId: blogProd!.id,
        trigger: 'webhook',
        status: 'failed',
        error: 'port déjà pris',
        createdAt: at(20),
      },
    ])
    await ctx.db.insert(webhookEvents).values({
      environmentId: siteProd!.id,
      source: 'gitlab',
      ip: '203.0.113.5',
      result: 'rejected',
      reason: 'Adresse non autorisée',
      createdAt: at(10),
    })
    for (const entry of [
      { username: 'alice', action: 'project.create', target: 'site', success: true },
      { username: 'bob', action: 'auth.login', target: 'bob', success: false },
      {
        username: 'alice',
        action: 'settings.registry.update',
        target: '=HYPERLINK("x")',
        success: true,
        details: { note: 'a;b "c"' },
      },
    ]) {
      await audit(ctx.db, { ...entry, ip: '198.51.100.1' })
    }
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('fusionne déploiements et webhooks, du plus récent au plus ancien', async () => {
    const all = (await get('/events/activity', 'viewer')).json() as ActivityItem[]
    expect(all.map((item) => `${item.kind}:${item.project.slug}`)).toEqual([
      'deployment:blog',
      'webhook:site',
      'deployment:site',
    ])
    const [failed] = all
    expect(failed).toMatchObject({ deployment: { status: 'failed', error: 'port déjà pris' } })
    expect(all[2]).toMatchObject({ deployment: { tags: ['v1.2'], trigger: 'user' } })

    const site = (await get('/events/activity?project=site&kind=webhook', 'viewer')).json()
    expect(site).toMatchObject([
      { kind: 'webhook', webhook: { result: 'rejected', source: 'gitlab' } },
    ])

    const older = (await get(`/events/activity?before=${all[1]!.at}`, 'viewer')).json()
    expect(older.map((item: ActivityItem) => item.id)).toEqual([all[2]!.id])
  })

  it('réserve le journal d’audit aux administrateurs et le filtre', async () => {
    expect((await get('/audit', 'viewer')).statusCode).toBe(403)
    const all = (await get('/audit')).json() as AuditEntryView[]
    expect(all.map((entry) => entry.action)).toEqual([
      'settings.registry.update',
      'auth.login',
      'project.create',
    ])
    expect((await get('/audit?user=alice')).json()).toHaveLength(2)
    expect((await get('/audit?action=settings')).json()).toHaveLength(1)
    expect((await get('/audit?success=false')).json()).toMatchObject([{ username: 'bob' }])
    const page = (await get(`/audit?before=${all[0]!.id}&limit=1`)).json()
    expect(page).toMatchObject([{ action: 'auth.login' }])
    expect((await get('/audit?from=2000-01-01&to=2000-01-02')).json()).toEqual([])
    expect((await get('/audit/users')).json()).toEqual(['alice', 'bob'])
  })

  it('exporte en CSV lisible par un tableur, sans formule', async () => {
    const response = await get('/audit/export.csv?user=alice')
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="vercio-audit-/)
    const lines = response.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(response.body.startsWith('\uFEFF')).toBe(true)
    expect(lines[0]).toBe('Date;Utilisateur;Action;Cible;Adresse IP;Résultat;Détails')
    expect(lines).toHaveLength(3)
    // Cible commençant par = : neutralisée ; détails avec ; et guillemets : protégés.
    expect(lines[1]).toContain(`;"'=HYPERLINK(""x"")";`)
    expect(lines[1]).toContain('"{""note"":""a;b \\""c\\""""}"')
  })
})
