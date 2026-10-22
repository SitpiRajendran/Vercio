import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql as rawSql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../src/db/client.js'
import {
  ADMIN_PASSWORD,
  controlledClock,
  cookieValue,
  ORIGIN,
  setupTestApp,
  TEST_DATABASE_URL,
  totpCode,
} from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('API — compte local', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let secret: string
  const clock = controlledClock()
  /** Mot de passe choisi à la première connexion, à la place de celui de l'installation. */
  const NEW_PASSWORD = 'nouveau-mot-de-passe-solide'

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await close?.()
  })

  function post(url: string, payload: unknown, cookie?: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      payload: payload as object,
    })
  }

  /** Connexion complète : mot de passe puis code TOTP. */
  async function login() {
    clock.tick()
    const first = await post('/api/auth/login', { username: 'admin', password: NEW_PASSWORD })
    expect(first.json()).toEqual({ next: 'totp' })
    const verify = await post(
      '/api/auth/totp/verify',
      { code: totpCode(secret, clock.step()) },
      cookieValue(first, '__Secure-vercio_mfa'),
    )
    expect(verify.json()).toEqual({ next: 'done' })
    return cookieValue(verify, '__Host-vercio_session')
  }

  it('expose la santé du service', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok', database: true, docker: true })
  })

  it('pose les en-têtes de sécurité (CSP, HSTS en HTTPS)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
    expect(response.headers['x-frame-options']).toBe('DENY')
  })

  it('annonce les modes de connexion', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(response.json()).toEqual({
      localEnabled: true,
      setupRequired: false,
      oidcEnabled: false,
      oidcProviderName: null,
    })
  })

  it('refuse un mot de passe invalide', async () => {
    const response = await post('/api/auth/login', { username: 'admin', password: 'mauvais' })
    expect(response.statusCode).toBe(401)
    expect(response.cookies.find((c) => c.name === '__Secure-vercio_mfa')).toBeUndefined()
  })

  it('impose l’enrôlement TOTP à la première connexion', async () => {
    const first = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })
    expect(first.json()).toEqual({ next: 'totp_setup' })
    expect(first.cookies.find((c) => c.name === '__Host-vercio_session')).toBeUndefined()

    const setup = await post('/api/auth/totp/setup', {}, cookieValue(first, '__Secure-vercio_mfa'))
    expect(setup.statusCode).toBe(200)
    const body = setup.json<{ secret: string; uri: string; qrSvg: string }>()
    expect(body.uri).toContain('otpauth://totp/')
    expect(body.qrSvg).toContain('<svg')
    secret = body.secret
    const mfa = cookieValue(setup, '__Secure-vercio_mfa')

    const wrong = await post('/api/auth/totp/verify', { code: '000000' }, mfa)
    expect(wrong.statusCode).toBe(401)

    // Le mot de passe d'installation est temporaire : pas de session avant de l'avoir remplacé.
    const ok = await post('/api/auth/totp/verify', { code: totpCode(secret, clock.step()) }, mfa)
    expect(ok.json()).toEqual({ next: 'password_change' })
    expect(ok.cookies.find((c) => c.name === '__Host-vercio_session')).toBeUndefined()
    const ticket = cookieValue(ok, '__Secure-vercio_mfa')

    // Un ticket « mot de passe » ne permet pas de rejouer l'étape TOTP.
    const again = await post('/api/auth/totp/verify', { code: '123456' }, ticket)
    expect(again.statusCode).toBe(401)
    const short = await post('/api/auth/password/initial', { password: 'court' }, ticket)
    expect(short.json()).toMatchObject({ error: '12 caractères minimum', field: 'password' })
    const same = await post('/api/auth/password/initial', { password: ADMIN_PASSWORD }, ticket)
    expect(same.statusCode).toBe(400)

    const changed = await post('/api/auth/password/initial', { password: NEW_PASSWORD }, ticket)
    expect(changed.statusCode).toBe(200)
    const sessionCookie = changed.cookies.find((c) => c.name === '__Host-vercio_session')
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(sessionCookie?.secure).toBe(true)

    // L'ancien mot de passe ne fonctionne plus.
    const old = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })
    expect(old.statusCode).toBe(401)
  })

  it('refuse la réutilisation d’un code TOTP', async () => {
    const first = await post('/api/auth/login', { username: 'admin', password: NEW_PASSWORD })
    const replay = await post(
      '/api/auth/totp/verify',
      { code: totpCode(secret, clock.step()) },
      cookieValue(first, '__Secure-vercio_mfa'),
    )
    expect(replay.statusCode).toBe(401)
  })

  it('refuse un ticket TOTP falsifié', async () => {
    const response = await post(
      '/api/auth/totp/verify',
      { code: '123456' },
      '__Secure-vercio_mfa=v1:a:b:c',
    )
    expect(response.statusCode).toBe(401)
  })

  it('connecte l’administrateur et renvoie son profil', async () => {
    const cookie = await login()
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.json()).toMatchObject({
      username: 'admin',
      roles: ['vercio-admin'],
      provider: 'local',
    })
  })

  it('protège les routes par rôle', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/system/docker' })
    expect(anonymous.statusCode).toBe(401)

    const cookie = await login()
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/docker',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ cpus: 4 })

    // Espace disque du dossier de données (tableau de bord).
    expect((await app.inject({ method: 'GET', url: '/api/system/disk' })).statusCode).toBe(401)
    const disk = await app.inject({ method: 'GET', url: '/api/system/disk', headers: { cookie } })
    expect(disk.statusCode).toBe(200)
    const usage = disk.json().at(-1)
    expect(usage).toMatchObject({ label: 'données de Vercio', level: expect.any(String) })
    expect(usage.totalBytes).toBeGreaterThan(usage.freeBytes)
  })

  it('refuse une requête modifiante venant d’une autre origine', async () => {
    const cookie = await login()
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'https://malveillant.example' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('invalide la session à la déconnexion', async () => {
    const cookie = await login()
    const logout = await post('/api/auth/logout', {}, cookie)
    expect(logout.json()).toEqual({ redirectTo: null })
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })

  it('gère plusieurs applications d’authentification, en gardant au moins une', async () => {
    const session = await login()
    const call = (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: object,
      cookie = session,
    ) => app.inject({ method, url, headers: { origin: ORIGIN, cookie }, payload })
    const list = async () =>
      (await call('GET', '/api/auth/totp/devices')).json<{ id: string; name: string }[]>()

    const [first] = await list()
    expect(first).toMatchObject({ name: 'Application d’authentification' })
    const last = await call('DELETE', `/api/auth/totp/devices/${first!.id}`, {
      currentPassword: NEW_PASSWORD,
    })
    expect(last.statusCode).toBe(400)
    expect(last.json().error).toContain('au moins une')

    // Ajout : QR code, puis nom, code et mot de passe actuel.
    const setup = await call('POST', '/api/auth/totp/devices/setup', {})
    const second = setup.json<{ secret: string }>().secret
    const both = `${session}; ${cookieValue(setup, '__Secure-vercio_totp_device')}`
    clock.tick()
    const add = (payload: object) => call('POST', '/api/auth/totp/devices', payload, both)
    const code = totpCode(second, clock.step())
    const wrongPassword = await add({ name: 'Secours', code, currentPassword: 'mauvais' })
    expect(wrongPassword.json()).toMatchObject({ field: 'currentPassword' })
    const wrongCode = await add({ name: 'Secours', code: '000000', currentPassword: NEW_PASSWORD })
    expect(wrongCode.json()).toMatchObject({ field: 'code' })
    // Sans le cookie du QR code, rien n'est ajouté.
    const expired = await call('POST', '/api/auth/totp/devices', {
      name: 'Secours',
      code,
      currentPassword: NEW_PASSWORD,
    })
    expect(expired.statusCode).toBe(400)
    const added = await add({ name: 'Secours', code, currentPassword: NEW_PASSWORD })
    expect(added.statusCode).toBe(201)
    expect((await list()).map((device) => device.name)).toEqual([
      'Application d’authentification',
      'Secours',
    ])

    // L'une ou l'autre permet de se connecter.
    secret = second
    await login()

    expect(
      (await call('DELETE', `/api/auth/totp/devices/${first!.id}`, { currentPassword: 'mauvais' }))
        .statusCode,
    ).toBe(400)
    const removed = await call('DELETE', `/api/auth/totp/devices/${first!.id}`, {
      currentPassword: NEW_PASSWORD,
    })
    expect(removed.statusCode).toBe(204)
    expect((await list()).map((device) => device.name)).toEqual(['Secours'])
    const missing = await call('DELETE', `/api/auth/totp/devices/${first!.id}`, {
      currentPassword: NEW_PASSWORD,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('journalise les connexions', async () => {
    const rows = await db.execute<{ action: string; success: boolean }>(
      rawSql`select action, success from audit_logs`,
    )
    const actions = rows.map((row) => `${row.action}:${row.success}`)
    expect(actions).toContain('auth.login:false')
    expect(actions).toContain('auth.totp:false')
    expect(actions).toContain('auth.totp.enroll:true')
    expect(actions).toContain('auth.login:true')
    expect(actions).toContain('auth.password.initial:true')
    expect(actions).toContain('auth.totp.add:true')
    expect(actions).toContain('auth.totp.remove:true')
  })
})

describe('Blocage des codes TOTP', () => {
  it('bloque un compte après 5 codes invalides, quelle que soit l’adresse', async () => {
    const { totpFailed, totpLocked } = await import('../src/auth/routes.js')
    const id = 'compte-attaque'
    for (let i = 0; i < 4; i++) totpFailed(id)
    expect(totpLocked(id)).toBe(false)
    totpFailed(id)
    expect(totpLocked(id)).toBe(true)
    expect(totpLocked('autre-compte')).toBe(false)
  })
})
