import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { NotificationChannelView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { Database } from '../src/db/client.js'
import { auditLogs, notificationChannels, projects, users } from '../src/db/schema.js'
import { buildMessage } from '../src/notifications/message.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const TEAMS_URL_PATH = '/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRET-SIG'

describe.skipIf(!TEST_DATABASE_URL)('API — notifications', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let admin: string
  let deployer: string
  let receiver: Server
  let receiverUrl: string
  const received: { path: string; body: string }[] = []
  let smtp: SMTPServer
  let smtpPort: number
  const mails: { to: string[]; auth: string | null }[] = []

  async function sessionFor(username: string, roles: string[], email: string | null = null) {
    const [user] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: username,
        username,
        displayName: username,
        roles,
        email,
      })
      .returning()
    const { token } = await new SessionStore(db, 3_600_000).create(user!.id, {})
    return `__Host-vercio_session=${token}`
  }

  function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    cookie = admin,
  ) {
    return app.inject({
      method,
      url: `/api/settings${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })
  }

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
    admin = await sessionFor('admin-sso', ['vercio-admin'], 'admin@example.com')
    deployer = await sessionFor('deployer-sso', ['vercio-deployer'])
    receiver = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received.push({ path: request.url ?? '', body })
        response.writeHead(202).end()
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`

    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth(auth, _session, callback) {
        if (auth.username === 'vercio' && auth.password === 'smtp-secret') {
          return callback(null, { user: auth.username })
        }
        callback(new Error('Invalid username or password'))
      },
      onData(stream, session, callback) {
        stream.resume()
        stream.on('end', () => {
          mails.push({
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            auth: (session.user as string | undefined) ?? null,
          })
          callback()
        })
      },
    })
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    smtpPort = (smtp.server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((resolve) => receiver?.close(resolve))
    await new Promise<void>((resolve) => (smtp ? smtp.close(() => resolve()) : resolve()))
    await close?.()
  })

  it('réserve les notifications aux administrateurs', async () => {
    for (const url of ['/notifications/channels', '/notifications/deliveries', '/smtp']) {
      expect((await call('GET', url, undefined, deployer)).statusCode).toBe(403)
    }
    const response = await call(
      'POST',
      '/notifications/channels',
      { type: 'teams', name: 'x', groups: ['disk.low'], url: 'https://exemple.com' },
      deployer,
    )
    expect(response.statusCode).toBe(403)
  })

  it('Teams : URL signée jamais renvoyée, gardée si le champ est laissé vide', async () => {
    const created = await call('POST', '/notifications/channels', {
      type: 'teams',
      name: 'Équipe Ops',
      groups: ['deployment.failed', 'disk.low'],
      url: `https://prod-01.westeurope.environment.api.powerplatform.com${TEAMS_URL_PATH}`,
    })
    expect(created.statusCode).toBe(201)
    const { channel, secret } = created.json()
    expect(secret).toBeNull()
    expect(channel).toMatchObject({
      type: 'teams',
      teams: { urlHint: 'https://prod-01.westeurope.environment.api.powerplatform.com/…' },
      groups: ['deployment.failed', 'disk.low'],
      projectScope: 'all',
    })
    const list = await call('GET', '/notifications/channels')
    expect(JSON.stringify(list.json())).not.toContain('SECRET-SIG')

    const updated = await call('PUT', `/notifications/channels/${channel.id}`, {
      type: 'teams',
      name: 'Équipe Ops',
      groups: ['disk.low'],
      enabled: false,
    })
    expect(updated.json()).toMatchObject({ enabled: false, groups: ['disk.low'] })
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channel.id))
    expect(app.notifications.readConfig(row!)).toMatchObject({
      url: expect.stringContaining('sig=SECRET-SIG'),
    })

    // Le type ne change pas ; une adresse interdite est refusée.
    const retype = await call('PUT', `/notifications/channels/${channel.id}`, {
      type: 'webhook',
      name: 'Équipe Ops',
      groups: ['disk.low'],
    })
    expect(retype.json()).toMatchObject({ field: 'type' })
    const ssrf = await call('POST', '/notifications/channels', {
      type: 'webhook',
      name: 'Métadonnées',
      groups: ['disk.low'],
      url: 'https://169.254.169.254/latest/meta-data',
    })
    expect(ssrf.statusCode).toBe(400)
    expect(ssrf.json().error).toContain('Adresse interdite')

    expect((await call('DELETE', `/notifications/channels/${channel.id}`)).statusCode).toBe(204)
  })

  it('webhook sortant : secret affiché une fois, renouvelable, test signé', async () => {
    const [project] = await db
      .insert(projects)
      .values({ name: 'Boutique', slug: 'boutique', type: 'compose' })
      .returning()
    const created = await call('POST', '/notifications/channels', {
      type: 'webhook',
      name: 'Supervision',
      groups: ['deployment.failed'],
      url: `${receiverUrl}/hook?token=abc`,
      allowHttp: true,
      projectScope: 'selected',
      projectIds: [project!.id],
      environmentSlugs: ['production'],
    })
    expect(created.statusCode).toBe(201)
    const { channel, secret } = created.json() as {
      channel: NotificationChannelView
      secret: string
    }
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/)
    expect(channel).toMatchObject({
      webhook: { url: `${receiverUrl}/hook?…`, hasSecret: true, allowHttp: true },
      projects: [{ slug: 'boutique' }],
      environmentSlugs: ['production'],
    })
    expect(JSON.stringify((await call('GET', '/notifications/channels')).json())).not.toContain(
      secret,
    )

    const renewed = await call('POST', `/notifications/channels/${channel.id}/regenerate-secret`)
    expect(renewed.json().secret).toMatch(/^whsec_/)
    expect(renewed.json().secret).not.toBe(secret)

    const test = await call('POST', `/notifications/channels/${channel.id}/test`)
    expect(test.json()).toMatchObject({ ok: true, message: 'Reçu (HTTP 202)' })
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({ event: 'test' })

    // Journal : le test y figure.
    const deliveries = await call('GET', `/notifications/deliveries?channelId=${channel.id}`)
    expect(deliveries.json()).toMatchObject([
      { event: 'test', status: 'sent', channelName: 'Supervision' },
    ])

    // Test du formulaire, avant enregistrement : la configuration saisie est utilisée.
    const form = await call('POST', '/notifications/channels/test', {
      id: channel.id,
      channel: {
        type: 'webhook',
        name: 'Supervision',
        groups: ['deployment.failed'],
        url: `${receiverUrl}/autre`,
        allowHttp: true,
      },
    })
    expect(form.json()).toMatchObject({ ok: true })
    expect(received.at(-1)!.path).toBe('/autre')

    const actions = (await db.select().from(auditLogs)).map((row) => row.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'settings.notification_channel.create',
        'settings.notification_channel.regenerate_secret',
        'settings.notification_channel.test',
      ]),
    )
    const audit = JSON.stringify(await db.select().from(auditLogs))
    expect(audit).not.toContain('token=abc')
  })

  it('SMTP : mot de passe en écriture seule, réutilisé seulement vers le même serveur', async () => {
    expect((await call('GET', '/smtp')).json()).toMatchObject({ configured: false, port: 587 })
    const settings = {
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      username: 'vercio',
      password: 'smtp-secret',
      from: 'vercio@example.com',
    }
    const saved = await call('PUT', '/smtp', settings)
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ configured: true, hasPassword: true, username: 'vercio' })
    expect(JSON.stringify(saved.json())).not.toContain('smtp-secret')

    // Mot de passe enregistré : test de connexion puis email de test.
    const withoutPassword = { ...settings, password: undefined }
    const test = await call('POST', '/smtp/test', {
      settings: withoutPassword,
      to: 'admin@example.com',
    })
    expect(test.json()).toMatchObject({
      ok: true,
      message: 'Email de test envoyé à admin@example.com',
    })
    expect(mails.at(-1)).toEqual({ to: ['admin@example.com'], auth: 'vercio' })
    expect((await call('GET', '/smtp')).json().lastCheck).toMatchObject({ ok: true })

    // Vers un autre serveur, le mot de passe enregistré n'est jamais envoyé.
    const elsewhere = await call('POST', '/smtp/test', {
      settings: { ...withoutPassword, host: 'smtp.piege.example', security: 'starttls' },
    })
    expect(elsewhere.statusCode).toBe(400)
    expect(elsewhere.json()).toMatchObject({ field: 'password' })
    expect(
      (
        await call('PUT', '/smtp', {
          ...withoutPassword,
          host: 'smtp.piege.example',
          security: 'starttls',
        })
      ).statusCode,
    ).toBe(400)

    // Mauvais mot de passe : erreur expliquée.
    const wrong = await call('POST', '/smtp/test', { settings: { ...settings, password: 'faux' } })
    expect(wrong.json()).toMatchObject({ ok: false })
    expect(wrong.json().message).toContain('Identifiant ou mot de passe refusé')

    // Mot de passe en clair vers un hôte distant : refusé.
    const plain = await call('PUT', '/smtp', { ...settings, host: 'smtp.example.com' })
    expect(plain.statusCode).toBe(400)
    expect(plain.json()).toMatchObject({ field: 'security' })

    // Canal email vers les administrateurs, envoyé par la file.
    const created = await call('POST', '/notifications/channels', {
      type: 'email',
      name: 'Admins',
      groups: ['disk.low'],
      allAdmins: true,
    })
    expect(created.json().channel).toMatchObject({ email: { allAdmins: true, recipients: [] } })
    await app.notifications.emit(
      buildMessage({
        event: 'disk.low',
        severity: 'warning',
        title: 'Espace disque faible',
        summary: '3 Gio libres',
        facts: [],
        project: null,
        environment: null,
        incident: null,
      }),
    )
    await app.notifications.drain()
    expect(mails.at(-1)!.to).toEqual(['admin@example.com'])
    expect((await call('GET', '/notifications/me')).json()).toEqual({ email: 'admin@example.com' })

    expect((await call('DELETE', '/smtp')).statusCode).toBe(204)
    expect((await call('GET', '/smtp')).json()).toMatchObject({ configured: false })
  })
})
