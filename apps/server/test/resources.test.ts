import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContainerStatsSample, OverviewView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { notificationIncidents, users } from '../src/db/schema.js'
import type { StatsSampler } from '../src/docker/stats.js'
import { measure, ResourceWatcher } from '../src/notifications/resources.js'
import {
  addWatchChannel,
  FakeHost,
  ORIGIN,
  queuedNotifications,
  setupTestApp,
  TEST_DATABASE_URL,
} from './helpers.js'

const sample = (cpu: number | null, memory: number): ContainerStatsSample => ({
  at: new Date().toISOString(),
  cpuPercent: cpu,
  memoryBytes: memory,
  memoryLimitBytes: 1000,
  netRxBytes: 0,
  netTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
  pids: 1,
})

describe('Mesure moyenne', () => {
  it('moyenne les dernières mesures, en % d’un cœur ou de la limite', () => {
    const samples = [sample(null, 100), sample(80, 900), sample(100, 950)]
    expect(measure(samples, 'cpu', 6)).toBe(90)
    expect(measure(samples, 'memory', 2)).toBe(92.5)
    expect(measure([sample(null, 100)], 'cpu', 6)).toBeNull()
  })
})

describe.skipIf(!TEST_DATABASE_URL)('Saturation CPU et mémoire', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  // Horloge du test : quelques heures en arrière, pour rester dans les dernières 24 h réelles.
  let now = Date.now() - 6 * 3_600_000
  let samples: ContainerStatsSample[] = []
  let deploying = false
  let watcher: ResourceWatcher
  let envId: string
  let cookie: string

  beforeAll(async () => {
    ctx = await setupTestApp({}, undefined, host)
    const [user] = await ctx.db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'admin',
        username: 'admin',
        displayName: 'admin',
        roles: ['vercio-admin'],
      })
      .returning()
    cookie = `__Host-vercio_session=${(await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})).token}`
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, origin: ORIGIN },
      payload: {
        name: 'Site',
        slug: 'site',
        type: 'compose',
        compose: { source: 'inline', content: 'services:\n  web:\n    image: nginx\n' },
        sources: [],
        trackedServices: [],
        environments: [{ name: 'Production', slug: 'prod', sources: [] }],
      },
    })
    envId = created.json().environments[0].id
    host.containers.set('vercio_site_prod', [
      {
        id: 'c-web',
        name: 'vercio_site_prod-web-1',
        service: 'web',
        image: 'nginx',
        state: 'running',
        status: 'Up',
        health: null,
        createdAt: new Date().toISOString(),
        ports: [],
      },
    ])
    await addWatchChannel(ctx.db, ['container.resources'])
    const stats = { history: () => new Map([['c-web', samples]]) } as unknown as StatsSampler
    watcher = new ResourceWatcher({
      db: ctx.db,
      host,
      stats,
      engine: { isDeploying: () => deploying },
      notifications: ctx.app.notifications,
      log: ctx.app.log,
      now: () => now,
    })
  })

  afterAll(async () => {
    await ctx?.close()
  })

  /** Mesures hautes (ou basses) pendant `minutes`, vérifiées toutes les 30 s. */
  async function run(memory: number, minutes: number) {
    samples = Array.from({ length: 6 }, () => sample(5, memory))
    for (let elapsed = 0; elapsed < minutes * 60_000; elapsed += 30_000) {
      await watcher.check()
      now += 30_000
    }
  }

  const episodes = () => ctx.db.select().from(notificationIncidents)

  it('ignore un pic bref, enregistre un épisode tenu 2 minutes', async () => {
    await run(950, 1)
    await run(100, 3)
    expect(await episodes()).toHaveLength(0)
    await run(950, 3)
    const [episode] = await episodes()
    expect(episode).toMatchObject({ kind: 'resources', resolvedAt: null, environmentId: envId })
    expect(episode!.data).toMatchObject({ service: 'web', metric: 'memory' })
    // Un seul épisode : pas encore de notification.
    expect(await queuedNotifications(ctx.db)).toHaveLength(0)
    await run(100, 3)
    expect((await episodes())[0]!.resolvedAt).not.toBeNull()
  })

  it('notifie au troisième épisode en 24 h, une seule fois', async () => {
    await run(950, 3)
    await run(100, 3)
    expect(await queuedNotifications(ctx.db)).toHaveLength(0)
    await run(980, 3)
    await run(100, 3)
    const sent = await queuedNotifications(ctx.db)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      event: 'container.resources',
      severity: 'warning',
      title: 'Mémoire presque pleine · web · Site / Production',
    })
    expect(sent[0]!.summary).toContain('3 épisodes de saturation de la mémoire en 24 h')
    await run(950, 3)
    await run(100, 3)
    expect(await queuedNotifications(ctx.db)).toHaveLength(1)
    expect(await episodes()).toHaveLength(4)
  })

  it('résume les épisodes dans la vue d’ensemble', async () => {
    await run(950, 3)
    const view = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/overview',
        headers: { cookie, origin: ORIGIN },
      })
    ).json() as OverviewView
    expect(view.projects[0]!.environments[0]!.alerts).toEqual([
      expect.objectContaining({
        service: 'web',
        metric: 'memory',
        episodes: 5,
        active: true,
        peak: 98,
      }),
    ])
  })

  it('reste silencieux pendant un déploiement', async () => {
    await run(100, 3)
    const before = (await episodes()).length
    deploying = true
    await run(990, 5)
    deploying = false
    expect(await episodes()).toHaveLength(before)
  })

  it('ferme après un redémarrage de Vercio l’épisode d’un conteneur disparu', async () => {
    await run(990, 3)
    const open = (await episodes()).filter((row) => row.resolvedAt === null)
    expect(open).toHaveLength(1)
    // Nouveau surveillant (Vercio redémarré) : le conteneur n'existe plus.
    const saved = host.containers.get('vercio_site_prod')!
    host.containers.delete('vercio_site_prod')
    const restarted = new ResourceWatcher({
      db: ctx.db,
      host,
      stats: { history: () => new Map() } as unknown as StatsSampler,
      engine: { isDeploying: () => false },
      notifications: ctx.app.notifications,
      log: ctx.app.log,
      now: () => now,
    })
    await restarted.check()
    expect((await episodes()).filter((row) => row.resolvedAt === null)).toHaveLength(0)
    host.containers.set('vercio_site_prod', saved)
  })

  it('applique les réglages : seuil, durée, désactivation', async () => {
    const put = (payload: object, role = cookie) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/settings/resource-alerts',
        headers: { cookie: role, origin: ORIGIN },
        payload,
      })
    const settings = {
      enabled: true,
      cpuPercent: 90,
      memoryPercent: 99,
      sustainMinutes: 5,
      frequentEpisodes: 3,
      longMinutes: 15,
    }
    expect((await put({ ...settings, memoryPercent: 5 })).statusCode).toBe(400)
    expect((await put(settings)).statusCode).toBe(200)
    await run(100, 6)
    const before = (await episodes()).length
    // 95 % de la limite : sous le nouveau seuil de 99 %.
    await run(950, 6)
    expect(await episodes()).toHaveLength(before)
    // 99,5 % pendant 4 min : sous la durée de 5 min ; pendant 6 min : épisode.
    await run(995, 4)
    expect(await episodes()).toHaveLength(before)
    await run(995, 3)
    expect(await episodes()).toHaveLength(before + 1)
    // Désactivée : l'épisode en cours se termine, rien de nouveau ne s'ouvre.
    expect((await put({ ...settings, enabled: false })).statusCode).toBe(200)
    await run(995, 10)
    const rows = await episodes()
    expect(rows).toHaveLength(before + 1)
    expect(rows.filter((row) => row.resolvedAt === null)).toHaveLength(0)
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings/resource-alerts',
      headers: { cookie, origin: ORIGIN },
    })
    expect(read.json()).toMatchObject({ enabled: false, memoryPercent: 99 })
  })
})
