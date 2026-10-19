import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { SMTPServer } from 'smtp-server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_GROUP_KEYS, type NotificationGroup } from '@vercio/shared'
import type { Database } from '../src/db/client.js'
import {
  appSettings,
  notificationChannelProjects,
  notificationChannels,
  notificationDeliveries,
  projects,
} from '../src/db/schema.js'
import { SecretBox } from '../src/lib/crypto.js'
import { buildMessage, type NotificationMessage } from '../src/notifications/message.js'
import type {
  ChannelConfig,
  NotificationService,
  StoredSmtp,
} from '../src/notifications/service.js'
import { setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const box = new SecretBox('x'.repeat(32))

interface Received {
  path: string
  headers: IncomingMessage['headers']
  body: string
}

/** Récepteur HTTP local : enregistre les appels, répond avec le statut demandé. */
async function receiver() {
  const calls: Received[] = []
  const state = { status: 200, retryAfter: null as string | null }
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      calls.push({ path: request.url ?? '/', headers: request.headers, body })
      if (state.retryAfter) response.setHeader('retry-after', state.retryAfter)
      response.writeHead(state.status).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { calls, state, url, close: () => new Promise((resolve) => server.close(resolve)) }
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    ...buildMessage({
      event: 'deployment.failed',
      severity: 'critical',
      title: 'Échec du déploiement · Site / Production',
      summary: 'L’environnement n’a pas été modifié.',
      facts: [{ label: 'Déclencheur', value: 'admin' }],
      details: 'compose up: erreur',
      url: 'https://vercio.example.com/projets/site/deploiements/1',
      project: { id: '00000000-0000-4000-8000-000000000001', slug: 'site', name: 'Site' },
      environment: {
        id: '00000000-0000-4000-8000-000000000002',
        slug: 'production',
        name: 'Production',
      },
      incident: null,
    }),
    ...overrides,
  }
}

async function addChannel(
  db: Database,
  name: string,
  config: ChannelConfig,
  options: {
    groups?: NotificationGroup[]
    projectScope?: 'all' | 'selected'
    projectIds?: string[]
    environmentSlugs?: string[]
  } = {},
) {
  const { type, ...secret } = config
  const [row] = await db
    .insert(notificationChannels)
    .values({
      name,
      type,
      configEnc: box.encrypt(JSON.stringify(secret)),
      groups: options.groups ?? NOTIFICATION_GROUP_KEYS,
      projectScope: options.projectScope ?? 'all',
      environmentSlugs: options.environmentSlugs ?? [],
    })
    .returning()
  for (const projectId of options.projectIds ?? []) {
    await db.insert(notificationChannelProjects).values({ channelId: row!.id, projectId })
  }
  return row!
}

async function deliveriesOf(db: Database, channelId: string) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))
    .orderBy(notificationDeliveries.createdAt)
}

describe.skipIf(!TEST_DATABASE_URL)('Notifications', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  let service: NotificationService
  let http: Awaited<ReturnType<typeof receiver>>

  beforeAll(async () => {
    ctx = await setupTestApp()
    service = ctx.app.notifications
    http = await receiver()
  })

  afterAll(async () => {
    await http.close()
    await ctx?.close()
  })

  beforeEach(async () => {
    await ctx.db.delete(notificationChannels)
    http.calls.length = 0
    http.state.status = 200
    http.state.retryAfter = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('signe le webhook sortant au format Standard Webhooks', async () => {
    const secret = `whsec_${Buffer.from('cle-de-test-0123456789').toString('base64')}`
    const channel = await addChannel(ctx.db, 'Webhook', {
      type: 'webhook',
      url: `${http.url}/hook?token=abc`,
      secret,
      allowHttp: true,
    })
    expect(await service.emit(message())).toBe(1)
    await service.drain()

    expect(http.calls).toHaveLength(1)
    const [call] = http.calls
    const id = call!.headers['webhook-id'] as string
    const timestamp = call!.headers['webhook-timestamp'] as string
    const expected = createHmac('sha256', Buffer.from('cle-de-test-0123456789'))
      .update(`${id}.${timestamp}.${call!.body}`)
      .digest('base64')
    expect(call!.headers['webhook-signature']).toBe(`v1,${expected}`)
    const body = JSON.parse(call!.body)
    expect(body).toMatchObject({
      id,
      schemaVersion: 1,
      event: 'deployment.failed',
      severity: 'critical',
      project: { slug: 'site' },
      environment: { slug: 'production' },
    })

    const [delivery] = await deliveriesOf(ctx.db, channel.id)
    expect(delivery).toMatchObject({ id, status: 'sent', attempts: 1, statusCode: 200 })
    const [saved] = await ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channel.id))
    expect(saved!.lastResult).toMatchObject({ ok: true })
  })

  it('refuse le HTTP non chiffré sans la case dédiée', async () => {
    const channel = await addChannel(ctx.db, 'Webhook', {
      type: 'webhook',
      url: http.url,
      secret: 'whsec_AAAA',
      allowHttp: false,
    })
    await service.emit(message())
    await service.drain()
    expect(http.calls).toHaveLength(0)
    const [delivery] = await deliveriesOf(ctx.db, channel.id)
    expect(delivery).toMatchObject({ status: 'failed' })
    expect(delivery!.error).toContain('HTTPS obligatoire')
  })

  it('filtre par évènement, projet et environnement ; alertes de l’hôte toujours livrées', async () => {
    const [project] = await ctx.db
      .insert(projects)
      .values({ name: 'Autre', slug: 'autre', type: 'compose' })
      .returning()
    const webhook = {
      type: 'webhook' as const,
      url: http.url,
      secret: 'whsec_AAAA',
      allowHttp: true,
    }
    const succeeded = await addChannel(ctx.db, 'Réussites', webhook, {
      groups: ['deployment.succeeded'],
    })
    const otherProject = await addChannel(ctx.db, 'Autre projet', webhook, {
      projectScope: 'selected',
      projectIds: [project!.id],
    })
    const staging = await addChannel(ctx.db, 'Staging', webhook, { environmentSlugs: ['staging'] })
    const all = await addChannel(ctx.db, 'Tout', webhook)

    expect(await service.emit(message())).toBe(1)
    const disk = message({
      event: 'disk.low',
      severity: 'warning',
      title: 'Espace disque faible',
      project: null,
      environment: null,
    })
    expect(await service.emit(disk)).toBe(3)

    expect(await deliveriesOf(ctx.db, all.id)).toHaveLength(2)
    expect(await deliveriesOf(ctx.db, succeeded.id)).toHaveLength(0)
    expect((await deliveriesOf(ctx.db, otherProject.id)).map((row) => row.event)).toEqual([
      'disk.low',
    ])
    expect((await deliveriesOf(ctx.db, staging.id)).map((row) => row.event)).toEqual(['disk.low'])
  })

  it('réessaie une erreur temporaire, abandonne une erreur définitive', async () => {
    const channel = await addChannel(ctx.db, 'Teams', { type: 'teams', url: `${http.url}/flow` })
    http.state.status = 503
    await service.emit(message())
    await service.drain()
    let [delivery] = await deliveriesOf(ctx.db, channel.id)
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, statusCode: 503 })
    expect(delivery!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000)

    // 30 s plus tard (± aléa), le récepteur répond de nouveau.
    http.state.status = 202
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    await service.drain()
    ;[delivery] = await deliveriesOf(ctx.db, channel.id)
    expect(delivery).toMatchObject({ status: 'sent', attempts: 2, statusCode: 202 })
    expect(http.calls).toHaveLength(2)
    const card = JSON.parse(http.calls[1]!.body)
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive')

    http.state.status = 404
    await service.emit(message())
    await service.drain()
    const rows = await deliveriesOf(ctx.db, channel.id)
    expect(rows[1]).toMatchObject({ status: 'failed', attempts: 1, statusCode: 404 })
    expect(rows[1]!.error).toContain('Workflow Teams introuvable')
  })

  it('signale une seule fois un canal en panne sur les autres canaux, puis son rétablissement', async () => {
    const broken = await addChannel(ctx.db, 'Cassé', {
      type: 'webhook',
      url: `${http.url}/casse`,
      secret: 'whsec_AAAA',
      allowHttp: false,
    })
    const ops = await addChannel(
      ctx.db,
      'Ops',
      {
        type: 'webhook',
        url: `${http.url}/ops`,
        secret: 'whsec_AAAA',
        allowHttp: true,
      },
      { groups: ['disk.low'] },
    )
    for (let i = 0; i < 4; i++)
      await service.emit(message({ event: 'disk.low', project: null, environment: null }))
    await service.drain()

    const opsRows = await deliveriesOf(ctx.db, ops.id)
    expect(opsRows.map((row) => row.event).filter((e) => e.startsWith('notification.'))).toEqual([
      'notification.channel_failing',
    ])
    const [saved] = await ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, broken.id))
    expect(saved).toMatchObject({ consecutiveFailures: 4, failureNotified: true })
    expect(saved!.failingSince).not.toBeNull()

    // Le canal est réparé : le premier envoi réussi annonce le rétablissement.
    await ctx.db
      .update(notificationChannels)
      .set({
        configEnc: box.encrypt(
          JSON.stringify({ url: `${http.url}/casse`, secret: 'whsec_AAAA', allowHttp: true }),
        ),
      })
      .where(eq(notificationChannels.id, broken.id))
    await service.emit(message({ event: 'disk.low', project: null, environment: null }))
    await service.drain()
    const events = (await deliveriesOf(ctx.db, ops.id)).map((row) => row.event)
    expect(events.filter((e) => e.startsWith('notification.'))).toEqual([
      'notification.channel_failing',
      'notification.channel_recovered',
    ])
  })

  it('une coupure brève n’est pas signalée, une panne de plus de 30 min l’est', async () => {
    const teams = await addChannel(ctx.db, 'Teams', { type: 'teams', url: `${http.url}/flow` })
    const ops = await addChannel(
      ctx.db,
      'Ops',
      { type: 'webhook', url: `${http.url}/ops`, secret: 'whsec_AAAA', allowHttp: true },
      { groups: ['disk.low'] },
    )
    http.state.status = 503
    await service.emit(message())
    let now = Date.now()
    // Trois échecs temporaires en quelques minutes : pas d'alerte.
    for (let i = 0; i < 3; i++) {
      vi.useFakeTimers({ toFake: ['Date'], now })
      await service.drain()
      now += 11 * 60_000
    }
    const failing = async () =>
      (await deliveriesOf(ctx.db, ops.id)).filter(
        (row) => row.event === 'notification.channel_failing',
      )
    expect(await failing()).toHaveLength(0)
    // Toujours en échec plus de 30 min après le premier : la panne est signalée.
    vi.useFakeTimers({ toFake: ['Date'], now: now + 40 * 60_000 })
    await service.drain()
    expect(await failing()).toHaveLength(1)
    const [saved] = await ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, teams.id))
    expect(saved).toMatchObject({ failureNotified: true })
  })

  it('anti-spam : les répétitions d’une même clé sont comptées sur le premier message', async () => {
    const channel = await addChannel(ctx.db, 'Webhook', {
      type: 'webhook',
      url: http.url,
      secret: 'whsec_AAAA',
      allowHttp: true,
    })
    const rejected = message({ event: 'webhook.rejected', severity: 'warning' })
    await service.emit(rejected, { dedupeKey: 'webhook.rejected:env' })
    await service.emit(rejected, { dedupeKey: 'webhook.rejected:env' })
    await service.emit(rejected, { dedupeKey: 'webhook.rejected:env' })
    const rows = await deliveriesOf(ctx.db, channel.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.suppressedCount).toBe(2)
    await service.drain()
    expect(JSON.parse(http.calls[0]!.body).facts).toContainEqual({
      label: 'Répétitions',
      value: '2 de plus en 15 min',
    })
  })

  it('Teams : regroupe les alertes d’un environnement et respecte la limite de débit', async () => {
    const channel = await addChannel(ctx.db, 'Teams', { type: 'teams', url: `${http.url}/flow` })
    http.state.status = 202
    // Trois alertes conteneur du même environnement : une seule carte après 30 s.
    for (const service$ of ['front', 'back', 'redis']) {
      await service.emit(
        message({ event: 'container.down', title: `Service arrêté · ${service$}` }),
        { groupKey: 'env:production' },
      )
    }
    await service.drain()
    expect(http.calls).toHaveLength(0)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 })
    await service.drain()
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]!.body).toContain('3 alertes')

    // 30 messages d'un coup : 20 envois au plus en 5 min, le dernier est un récapitulatif.
    http.calls.length = 0
    await ctx.db.delete(notificationDeliveries)
    for (let i = 0; i < 30; i++) await service.emit(message({ title: `Message ${i}` }))
    await service.drain()
    expect(http.calls).toHaveLength(20)
    expect(http.calls[19]!.body).toContain('11 alertes')
    const rows = await deliveriesOf(ctx.db, channel.id)
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(30)
    expect(rows.filter((row) => row.mergedIntoId)).toHaveLength(10)
  })

  it('envoie un email par le serveur SMTP configuré, avec les administrateurs', async () => {
    const mails: { from: string; to: string[]; data: string }[] = []
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        let data = ''
        stream.on('data', (chunk) => (data += chunk))
        stream.on('end', () => {
          mails.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            data,
          })
          callback()
        })
      },
    })
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    const port = (smtp.server.address() as AddressInfo).port
    try {
      const settings: StoredSmtp = {
        host: '127.0.0.1',
        port,
        security: 'none',
        username: null,
        passwordEnc: null,
        from: 'vercio@example.com',
        fromName: 'Vercio',
        caCertificate: null,
        lastCheck: null,
      }
      await ctx.db.insert(appSettings).values({ key: 'smtp', value: settings })
      const channel = await addChannel(ctx.db, 'Email', {
        type: 'email',
        recipients: ['ops@example.com'],
        allAdmins: false,
      })
      await service.emit(message())
      await service.drain()
      expect(mails).toHaveLength(1)
      expect(mails[0]!.to).toEqual(['ops@example.com'])
      expect(mails[0]!.data).toContain('Auto-Submitted: auto-generated')
      expect(mails[0]!.data).toMatch(/Subject: .*Vercio/)
      const [delivery] = await deliveriesOf(ctx.db, channel.id)
      expect(delivery).toMatchObject({ status: 'sent', statusCode: 250 })

      const result = await service.test(
        { type: 'email', recipients: ['test@example.com'], allAdmins: false },
        'Email',
        channel.id,
      )
      expect(result.ok).toBe(true)
      expect(mails[1]!.to).toEqual(['test@example.com'])
      const rows = await deliveriesOf(ctx.db, channel.id)
      expect(rows.map((row) => row.event)).toEqual(['deployment.failed', 'test'])
    } finally {
      await ctx.db.delete(appSettings).where(eq(appSettings.key, 'smtp'))
      await new Promise<void>((resolve) => smtp.close(() => resolve()))
    }
  })

  it('canal email sans serveur SMTP : échec définitif, sans réessai', async () => {
    const channel = await addChannel(ctx.db, 'Email', {
      type: 'email',
      recipients: ['ops@example.com'],
      allAdmins: false,
    })
    await service.emit(message())
    await service.drain()
    const [delivery] = await deliveriesOf(ctx.db, channel.id)
    expect(delivery).toMatchObject({ status: 'failed', attempts: 1 })
    expect(delivery!.error).toContain('SMTP non configuré')
  })

  it('remet en file un envoi interrompu et purge le journal ancien', async () => {
    const channel = await addChannel(ctx.db, 'Webhook', {
      type: 'webhook',
      url: http.url,
      secret: 'whsec_AAAA',
      allowHttp: true,
    })
    await ctx.db.insert(notificationDeliveries).values([
      {
        channelId: channel.id,
        event: 'deployment.failed',
        severity: 'critical',
        title: 'Interrompu',
        message: message(),
        status: 'sending',
        lockedUntil: new Date(Date.now() - 1000),
      },
      {
        channelId: channel.id,
        event: 'deployment.failed',
        severity: 'critical',
        title: 'Ancien',
        message: message(),
        status: 'sent',
        createdAt: new Date(Date.now() - 40 * 24 * 3600_000),
      },
    ])
    await service.drain()
    await service.purge()
    const rows = await deliveriesOf(ctx.db, channel.id)
    expect(rows.map((row) => [row.title, row.status])).toEqual([['Interrompu', 'sent']])
  })
})
