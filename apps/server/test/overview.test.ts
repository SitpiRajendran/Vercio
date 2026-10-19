import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  ContainerStatsSample,
  ContainerUsage,
  OverviewView,
  ProjectView,
} from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { notificationIncidents, users } from '../src/db/schema.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const sample = (at: number, cpu: number | null, memory: number): ContainerStatsSample => ({
  at: new Date(at).toISOString(),
  cpuPercent: cpu,
  memoryBytes: memory,
  memoryLimitBytes: 1000,
  netRxBytes: 0,
  netTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
  pids: 1,
})

describe.skipIf(!TEST_DATABASE_URL)('Vue d’ensemble', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}
  let site: ProjectView

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, role = 'admin') =>
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
      icon: 'globe',
      color: 'teal',
      environments: [
        { name: 'Production', slug: 'prod', sources: [] },
        { name: 'Recette', slug: 'recette', sources: [] },
      ],
    })
    expect(created.statusCode).toBe(201)
    site = created.json()
    host.containers.set('vercio_site_prod', [
      {
        id: 'c-web',
        name: 'vercio_site_prod-web-1',
        service: 'web',
        image: 'nginx',
        state: 'running',
        status: 'Up 2 minutes (healthy)',
        health: 'healthy',
        createdAt: new Date().toISOString(),
        ports: ['8080→80/tcp'],
        published: [{ ip: null, hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
        networks: ['vercio_site_prod_default'],
        dependsOn: ['api'],
      },
    ])
    // Conteneur hors Vercio : jamais mesuré.
    host.containers.set('autre', [
      {
        id: 'c-other',
        name: 'autre-db-1',
        service: 'db',
        image: 'postgres',
        state: 'running',
        status: 'Up',
        health: null,
        createdAt: new Date().toISOString(),
        ports: [],
      },
    ])
    host.stats.set('c-web', [sample(1000, null, 100), sample(6000, 12.5, 200)])
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('renvoie projets, environnements et conteneurs en une requête', async () => {
    const response = await call('GET', '/overview', undefined, 'viewer')
    expect(response.statusCode).toBe(200)
    const view = response.json() as OverviewView
    expect(view.dockerError).toBeNull()
    expect(view.projects).toHaveLength(1)
    const [project] = view.projects
    expect(project).toMatchObject({ slug: 'site', icon: 'globe', color: 'teal', logo: null })
    expect(project!.environments.map((env) => env.slug)).toEqual(['prod', 'recette'])
    expect(project!.environments[0]!.containers).toEqual([
      expect.objectContaining({
        service: 'web',
        published: [{ ip: null, hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
        dependsOn: ['api'],
      }),
    ])
    expect(project!.environments[1]!.containers).toEqual([])
    expect(project!.environments[0]!.lastDeployment).toBeNull()
  })

  it('mesure la consommation des seuls conteneurs Vercio en marche', async () => {
    await call('GET', '/overview/usage', undefined, 'viewer')
    // Première demande : la mesure démarre ; les échantillons arrivent aussitôt (Docker simulé).
    const usage = (
      await call('GET', '/overview/usage', undefined, 'viewer')
    ).json() as ContainerUsage[]
    expect(usage).toEqual([
      expect.objectContaining({ id: 'c-web', memoryBytes: 200, memoryLimitBytes: 1000 }),
    ])
    expect(host.statsStreams.has('c-other')).toBe(false)
  })

  it('modifie l’apparence (admin seulement) et refuse une image invalide', async () => {
    const url = `/projects/${site.id}/appearance`
    expect((await call('PUT', url, { color: 'red' }, 'viewer')).statusCode).toBe(403)
    expect((await call('PUT', url, { logo: 'data:text/html;base64,PGI+' })).statusCode).toBe(400)
    expect((await call('PUT', url, { icon: 'inconnue' })).statusCode).toBe(400)
    const logo = 'data:image/png;base64,iVBORw0KGgo='
    const updated = await call('PUT', url, { color: 'red', logo })
    expect(updated.statusCode).toBe(200)
    // Champ absent : inchangé ; null : retiré.
    expect(updated.json()).toMatchObject({ icon: 'globe', color: 'red', logo })
    expect((await call('PUT', url, { logo: null })).json()).toMatchObject({ logo: null })
    expect((await call('PUT', url, { url: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await call('PUT', url, { url: 'https://www.exemple.fr' })).json()).toMatchObject({
      url: 'https://www.exemple.fr',
      icon: 'globe',
    })
    const list = (await call('GET', '/projects', undefined, 'viewer')).json()
    expect(list[0]).toMatchObject({ url: 'https://www.exemple.fr' })
  })

  it('ajoute à l’activité les actions sur les conteneurs et les pannes', async () => {
    const env = site.environments[0]!
    const action = await call(
      'POST',
      `/projects/${site.id}/environments/${env.id}/containers/actions`,
      {
        action: 'restart',
        service: 'web',
      },
    )
    expect(action.statusCode).toBe(200)
    await ctx.db.insert(notificationIncidents).values({
      key: 'container:vercio_site_prod/web/1',
      kind: 'down',
      environmentId: env.id,
      data: { service: 'web', exitCode: 137, oomKilled: true },
    })

    const items = (
      await call('GET', '/events/activity?project=site', undefined, 'viewer')
    ).json() as ActivityItem[]
    expect(items.map((item) => item.kind).sort()).toEqual(['action', 'incident'])
    expect(items.find((item) => item.kind === 'action')).toMatchObject({
      environment: { slug: 'prod' },
      action: { name: 'restart', service: 'web', username: 'admin', success: true },
    })
    expect(items.find((item) => item.kind === 'incident')).toMatchObject({
      incident: { type: 'down', service: 'web', detail: 'arrêté par manque de mémoire (OOM)' },
    })
    const onlyActions = (
      await call('GET', '/events/activity?kind=action', undefined, 'viewer')
    ).json()
    expect(onlyActions).toHaveLength(1)
    expect(
      (await call('GET', '/events/activity?project=autre', undefined, 'viewer')).json(),
    ).toEqual([])
  })
})
