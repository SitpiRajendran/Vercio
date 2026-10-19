import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  controlledClock,
  cookieValue,
  ORIGIN,
  setupTestApp,
  TEST_DATABASE_URL,
  totpCode,
} from './helpers.js'

const SETUP_CODE = 'code-installation-test'

describe.skipIf(!TEST_DATABASE_URL)('API — premier lancement', () => {
  let app: FastifyInstance
  let close: () => Promise<void>
  const clock = controlledClock()

  const post = (url: string, payload: object, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: `/api${url}`,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      payload,
    })
  const config = async () => (await app.inject({ method: 'GET', url: '/api/auth/config' })).json()
  const valid = {
    setupCode: SETUP_CODE,
    username: 'Sitpi',
    email: 'sitpi@example.com',
    password: 'une phrase de passe solide',
  }

  beforeAll(async () => {
    // Sans VERCIO_ADMIN_PASSWORD : aucun compte n'est créé au démarrage.
    ;({ app, close } = await setupTestApp({
      VERCIO_ADMIN_PASSWORD: '',
      VERCIO_SETUP_CODE: SETUP_CODE,
    }))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await close?.()
  })

  it('propose la page de premier lancement tant qu’aucun compte n’existe', async () => {
    expect(await config()).toMatchObject({ localEnabled: true, setupRequired: true })
    const login = await post('/auth/login', { username: 'admin', password: 'x' })
    expect(login.statusCode).toBe(401)
  })

  it('valide le code d’installation et le formulaire', async () => {
    const wrongCode = await post('/auth/setup', { ...valid, setupCode: 'faux-code' })
    expect(wrongCode.json()).toMatchObject({ field: 'setupCode' })
    expect(wrongCode.statusCode).toBe(401)
    const badEmail = await post('/auth/setup', { ...valid, email: 'pas-un-email' })
    expect(badEmail.json()).toMatchObject({ field: 'email' })
    const shortPassword = await post('/auth/setup', { ...valid, password: 'court' })
    expect(shortPassword.json()).toMatchObject({ field: 'password' })
    expect((await config()).setupRequired).toBe(true)
  })

  it('crée le premier administrateur, puis impose la double authentification', async () => {
    const created = await post('/auth/setup', valid)
    expect(created.json()).toEqual({ next: 'totp_setup' })
    expect(created.cookies.find((c) => c.name === '__Host-vercio_session')).toBeUndefined()

    const setup = await post('/auth/totp/setup', {}, cookieValue(created, '__Secure-vercio_mfa'))
    const { secret } = setup.json<{ secret: string }>()
    clock.tick()
    const verify = await post(
      '/auth/totp/verify',
      { code: totpCode(secret, clock.step()) },
      cookieValue(setup, '__Secure-vercio_mfa'),
    )
    // Mot de passe choisi par l'administrateur : pas de changement imposé.
    expect(verify.json()).toEqual({ next: 'done' })
    const cookie = cookieValue(verify, '__Host-vercio_session')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.json()).toMatchObject({
      username: 'sitpi',
      email: 'sitpi@example.com',
      roles: ['vercio-admin'],
      provider: 'local',
    })
  })

  it('ne peut plus servir une fois Vercio installé', async () => {
    expect((await config()).setupRequired).toBe(false)
    const again = await post('/auth/setup', { ...valid, username: 'intrus' })
    expect(again.statusCode).toBe(409)
  })
})
