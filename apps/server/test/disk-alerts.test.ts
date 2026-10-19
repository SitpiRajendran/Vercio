import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { notificationDeliveries } from '../src/db/schema.js'
import { DiskWatcher, diskLevel, thresholds, type DiskMeasure } from '../src/notifications/disk.js'
import { addWatchChannel, queuedNotifications, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const GIB = 1024 ** 3

function measure(freeGib: number, totalGib = 100, extra: Partial<DiskMeasure> = {}): DiskMeasure {
  return {
    device: 'disque-1',
    overlay: false,
    totalBytes: totalGib * GIB,
    freeBytes: freeGib * GIB,
    freeInodesRatio: 0.5,
    ...extra,
  }
}

describe('seuils d’espace disque', () => {
  it('alerte sous max(10 %, 5 Gio), critique sous max(5 %, 2 Gio)', () => {
    expect(thresholds(100 * GIB)).toMatchObject({ low: 10 * GIB, critical: 5 * GIB })
    expect(thresholds(20 * GIB)).toMatchObject({ low: 5 * GIB, critical: 2 * GIB })
    expect(diskLevel(measure(50), 'ok')).toBe('ok')
    expect(diskLevel(measure(9), 'ok')).toBe('low')
    expect(diskLevel(measure(4), 'ok')).toBe('critical')
    expect(diskLevel(measure(50, 100, { freeInodesRatio: 0.03 }), 'ok')).toBe('critical')
  })

  it('ne se rétablit qu’au-dessus du seuil + 5 points (hystérésis)', () => {
    expect(diskLevel(measure(12), 'low')).toBe('low')
    expect(diskLevel(measure(16), 'low')).toBe('ok')
  })
})

describe.skipIf(!TEST_DATABASE_URL)('Alertes disque', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const values = new Map<string, DiskMeasure>()

  beforeAll(async () => {
    ctx = await setupTestApp()
    await addWatchChannel(ctx.db, ['disk.low'])
  })

  afterAll(async () => {
    await ctx?.close()
  })

  const watcher = () =>
    new DiskWatcher({
      db: ctx.db,
      notifications: ctx.app.notifications,
      log: ctx.app.log,
      dataDir: '/var/lib/vercio',
      measure: async (path) => {
        const value = values.get(path)
        if (!value) throw new Error('absent')
        return value
      },
    })

  it('une alerte à l’ouverture, une à l’aggravation, une au retour à la normale', async () => {
    await ctx.db.delete(notificationDeliveries)
    const disk = watcher()
    // Hors conteneur : `/` n'est pas l'overlay de Docker, seul le dossier de données compte.
    values.set('/', measure(1, 100, { device: 'racine' }))
    values.set('/var/lib/vercio', measure(50))
    expect((await disk.check()).map((usage) => usage.path)).toEqual(['/var/lib/vercio'])

    values.set('/var/lib/vercio', measure(8))
    await disk.check()
    await disk.check()
    values.set('/var/lib/vercio', measure(3))
    await disk.check()
    values.set('/var/lib/vercio', measure(8))
    await disk.check()
    values.set('/var/lib/vercio', measure(30))
    await disk.check()

    const messages = await queuedNotifications(ctx.db)
    expect(messages.map((m) => m.event)).toEqual(['disk.low', 'disk.critical', 'disk.recovered'])
    expect(messages[0]).toMatchObject({ severity: 'warning', project: null, environment: null })
    expect(messages[0]!.summary).toContain('8.0 Gio libres sur 100.0 Gio (8 %)')
  })

  it('mesure l’overlay de Docker une seule fois s’il partage le disque des données', async () => {
    await ctx.db.delete(notificationDeliveries)
    values.set('/', measure(3, 100, { overlay: true, device: 'disque-1' }))
    values.set('/var/lib/vercio', measure(3))
    const usage = await watcher().check()
    expect(usage.map((item) => item.label)).toEqual(['images et conteneurs Docker'])
    expect((await queuedNotifications(ctx.db)).map((m) => m.event)).toEqual(['disk.critical'])
  })

  it('après un redémarrage, une alerte déjà ouverte n’est pas renvoyée', async () => {
    await ctx.db.delete(notificationDeliveries)
    await watcher().check()
    expect(await queuedNotifications(ctx.db)).toEqual([])
  })
})
