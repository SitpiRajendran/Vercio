import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environments,
  hosts,
  notificationDeliveries,
  notificationIncidents,
  projects,
} from '../src/db/schema.js'
import type { ContainerState } from '../src/docker/host-driver.js'
import { ContainerWatcher, describeExit } from '../src/notifications/containers.js'
import {
  addWatchChannel,
  FakeHost,
  ORIGIN,
  queuedNotifications,
  setupTestApp,
  TEST_DATABASE_URL,
} from './helpers.js'

const PROJECT = 'vercio_site_prod'

function container(overrides: Partial<ContainerState> = {}): ContainerState {
  return {
    id: 'c-back-1',
    name: 'vercio_site_prod-back-1',
    project: PROJECT,
    service: 'back',
    number: '1',
    oneoff: false,
    running: true,
    restarting: false,
    health: null,
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    restartPolicy: 'no',
    finishedAt: null,
    ...overrides,
  }
}

function labels(state: ContainerState, extra: Record<string, string> = {}) {
  return {
    'com.docker.compose.project': state.project,
    'com.docker.compose.service': state.service,
    'com.docker.compose.container-number': state.number,
    ...(state.oneoff ? { 'com.docker.compose.oneoff': 'True' } : {}),
    ...extra,
  }
}

describe('describeExit', () => {
  it('explique les codes de sortie courants', () => {
    expect(describeExit({ exitCode: 1, oomKilled: false })).toContain('code 1')
    expect(describeExit({ exitCode: 137, oomKilled: true })).toContain('manque de mémoire (OOM)')
    expect(describeExit({ exitCode: 137, oomKilled: false })).toContain('SIGKILL')
  })
})

describe.skipIf(!TEST_DATABASE_URL)('Alertes conteneur', () => {
  const host = new FakeHost()
  const engine = { deploying: false, isDeploying: () => engine.deploying }
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  let watcher: ContainerWatcher

  /** Applique l'état puis émet l'évènement, et attend son traitement. */
  async function event(action: string, state: ContainerState, extra: Record<string, string> = {}) {
    host.states.set(state.id, state)
    host.emitEvent({ action, id: state.id, attributes: labels(state, extra) })
    await watcher.idle()
  }

  const events = async () => (await queuedNotifications(ctx.db)).map((m) => m.event)

  beforeAll(async () => {
    ctx = await setupTestApp({}, undefined, host)
    const [project] = await ctx.db
      .insert(projects)
      .values({ name: 'Site', slug: 'site', type: 'compose' })
      .returning()
    const [localHost] = await ctx.db.select().from(hosts).limit(1)
    await ctx.db
      .insert(environments)
      .values({ projectId: project!.id, hostId: localHost!.id, name: 'Production', slug: 'prod' })
    await addWatchChannel(ctx.db, ['container.failed'])
    watcher = new ContainerWatcher({
      db: ctx.db,
      host,
      engine,
      notifications: ctx.app.notifications,
      log: ctx.app.log,
      delays: {
        confirmDown: 10,
        stableRunning: 10,
        stableHealthy: 10,
        stableLoop: 100,
        loopWindow: 1000,
        deployGrace: 0,
        reconcile: 3_600_000,
      },
    })
    watcher.start()
    await vi.waitFor(() => expect(host.watching).toBe(1))
  })

  afterAll(async () => {
    await watcher?.stop()
    await ctx?.close()
  })

  beforeEach(async () => {
    host.states.clear()
    engine.deploying = false
    await ctx.db.delete(notificationDeliveries)
    await ctx.db.delete(notificationIncidents)
  })

  it('signale un arrêt inattendu, puis le rétablissement', async () => {
    await event('die', container({ running: false, exitCode: 1 }), { exitCode: '1' })
    const [down] = await queuedNotifications(ctx.db)
    expect(down).toMatchObject({
      event: 'container.down',
      severity: 'critical',
      url: `${ORIGIN}/projets/site?onglet=logs&env=prod`,
      environment: { slug: 'prod' },
      incident: { status: 'open' },
    })
    expect(down!.summary).toContain('code 1')
    expect(down!.summary).toContain('ne redémarrera pas seul')
    // Les alertes d'un environnement partent groupées, après 30 s.
    const [row] = await ctx.db.select().from(notificationDeliveries)
    expect(row!.groupKey).toMatch(/^env:/)

    await event('start', container())
    expect(await events()).toEqual(['container.down', 'container.recovered'])
    const open = await ctx.db
      .select()
      .from(notificationIncidents)
      .where(isNull(notificationIncidents.resolvedAt))
    expect(open).toHaveLength(0)
  })

  it('ignore les arrêts volontaires, les conteneurs ponctuels et les déploiements', async () => {
    const stopped = container({ running: false, exitCode: 143 })
    await event('kill', stopped, { signal: '15' })
    await event('die', stopped, { exitCode: '143' })

    await event('die', container({ id: 'run-1', oneoff: true, running: false, exitCode: 1 }))

    // Pendant un déploiement, le conteneur est recréé : l'ancien a disparu à la vérification.
    engine.deploying = true
    host.states.set('old-1', container({ id: 'old-1', running: false, exitCode: 1 }))
    host.emitEvent({ action: 'die', id: 'old-1', attributes: labels(container()) })
    host.states.delete('old-1')
    engine.deploying = false
    await watcher.idle()

    await event('die', container({ project: 'autre_projet', running: false, exitCode: 1 }))
    expect(await events()).toEqual([])
  })

  it('un service qui plante juste après son déploiement est signalé une fois la période passée', async () => {
    engine.deploying = true
    host.states.set('c-back-1', container({ running: false, exitCode: 1 }))
    host.emitEvent({ action: 'die', id: 'c-back-1', attributes: labels(container()) })
    engine.deploying = false
    await watcher.idle()
    expect(await events()).toEqual(['container.down'])
  })

  it('prend en compte un environnement créé après le démarrage', async () => {
    const [project] = await ctx.db
      .insert(projects)
      .values({ name: 'Blog', slug: 'blog', type: 'compose' })
      .returning()
    const [localHost] = await ctx.db.select().from(hosts).limit(1)
    await ctx.db
      .insert(environments)
      .values({ projectId: project!.id, hostId: localHost!.id, name: 'Recette', slug: 'recette' })
    const crashed = container({
      id: 'blog-1',
      project: 'vercio_blog_recette',
      running: false,
      exitCode: 2,
    })
    await event('die', crashed)
    const [message] = await queuedNotifications(ctx.db)
    expect(message).toMatchObject({ event: 'container.down', environment: { slug: 'recette' } })
  })

  it('signale une boucle de redémarrage une seule fois, puis sa fin', async () => {
    const looping = container({ restartPolicy: 'always', restartCount: 3, exitCode: 1 })
    host.states.set(looping.id, looping)
    // Arrêts rapprochés : le conteneur est relancé à chaque fois par sa politique.
    for (let i = 0; i < 4; i++) {
      host.emitEvent({ action: 'die', id: looping.id, attributes: labels(looping) })
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    // Plus d'arrêt pendant la période de stabilité : la boucle est terminée.
    await watcher.idle()
    const messages = await queuedNotifications(ctx.db)
    expect(messages.map((m) => m.event)).toEqual(['container.restarting', 'container.recovered'])
    expect(messages[0]!.title).toContain('redémarre en boucle')
  })

  it('unhealthy : une alerte par incident, rétablie quand le healthcheck répond', async () => {
    const sick = container({ health: 'unhealthy' })
    await event('health_status: unhealthy', sick)
    await event('health_status: unhealthy', sick)
    await event('health_status: healthy', container({ health: 'healthy' }))
    expect(await events()).toEqual(['container.unhealthy', 'container.recovered'])
  })

  it('service instable : le premier retour est signalé, les suivants non', async () => {
    const crashed = container({ running: false, exitCode: 1 })
    await event('die', crashed)
    await event('start', container())
    await event('die', crashed)
    await event('start', container())
    await event('die', crashed)
    const messages = await queuedNotifications(ctx.db)
    expect(messages.map((m) => m.event)).toEqual([
      'container.down',
      'container.recovered',
      'container.down',
      'container.recovered',
    ])
    expect(messages[2]!.title).toContain('instable')
    const [incident] = await ctx.db
      .select()
      .from(notificationIncidents)
      .where(isNull(notificationIncidents.resolvedAt))
    expect(incident).toMatchObject({ occurrences: 3, notified: false })
  })

  it('réconciliation : ferme sans message les incidents des conteneurs disparus', async () => {
    await event('die', container({ running: false, exitCode: 1 }))
    host.states.clear()
    await watcher.reconcile()
    expect(await events()).toEqual(['container.down'])
    const open = await ctx.db
      .select()
      .from(notificationIncidents)
      .where(and(eq(notificationIncidents.kind, 'down'), isNull(notificationIncidents.resolvedAt)))
    expect(open).toHaveLength(0)

    // Conteneur trouvé en train de redémarrer en boucle (évènements manqués).
    host.states.set('c-back-1', container({ running: false, restarting: true, restartCount: 7 }))
    await watcher.reconcile()
    expect(await events()).toEqual(['container.down', 'container.restarting'])
  })
})
