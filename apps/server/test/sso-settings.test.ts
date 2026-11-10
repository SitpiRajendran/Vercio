import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../src/db/client.js'
import { eq } from 'drizzle-orm'
import { sessions, users } from '../src/db/schema.js'
import { SessionStore } from '../src/auth/sessions.js'
import { cookieValue, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'
import { CLIENT_SECRET, startFakeOidcProvider, type FakeUser } from './oidc-provider.js'

const ALICE: FakeUser = {
  sub: 'alice-sub',
  sid: 'session-alice',
  username: 'alice',
  name: 'Alice Martin',
  email: 'alice@example.com',
  clientRoles: ['vercio-admin'],
}

describe.skipIf(!TEST_DATABASE_URL)('API — SSO configuré depuis l’interface', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let provider: Awaited<ReturnType<typeof startFakeOidcProvider>>
  let admin: string

  async function sessionFor(provider: 'local' | 'oidc', username: string, roles: string[]) {
    const [user] = await db
      .insert(users)
      .values({ provider, subject: username, username, displayName: username, roles })
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
      url: `/api${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })
  }

  const settings = () => ({
    enabled: true,
    issuer: provider.issuer,
    clientId: 'vercio',
    clientSecret: CLIENT_SECRET,
    providerName: 'Keycloak maison',
    scopes: 'openid profile email',
    rolesClaims: 'resource_access.{clientId}.roles,realm_access.roles,groups',
  })

  beforeAll(async () => {
    provider = await startFakeOidcProvider('vercio')
    ;({ app, db, close } = await setupTestApp())
    admin = await sessionFor('local', 'admin-local', ['vercio-admin'])
  })

  afterAll(async () => {
    await close?.()
    await provider?.close()
  })

  it('part sans SSO et donne les adresses à déclarer dans Keycloak', async () => {
    const view = await call('GET', '/settings/sso')
    expect(view.json()).toMatchObject({
      source: 'none',
      enabled: false,
      hasSecret: false,
      redirectUri: `${ORIGIN}/api/auth/oidc/callback`,
      backchannelLogoutUri: `${ORIGIN}/api/auth/oidc/backchannel-logout`,
    })
    const config = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(config.json()).toMatchObject({ oidcEnabled: false })
  })

  it('réserve la page aux administrateurs', async () => {
    const viewer = await sessionFor('local', 'lecteur', ['vercio-viewer'])
    expect((await call('GET', '/settings/sso', undefined, viewer)).statusCode).toBe(403)
  })

  it('teste la connexion : realm, client et secret', async () => {
    const ok = await call('POST', '/settings/sso/test', settings())
    expect(ok.json(), ok.json().message).toMatchObject({ ok: true })

    const wrongSecret = await call('POST', '/settings/sso/test', {
      ...settings(),
      clientSecret: 'faux',
    })
    expect(wrongSecret.json()).toMatchObject({ ok: false })
    expect(wrongSecret.json().message).toMatch(/secret refusé/)

    const wrongRealm = await call('POST', '/settings/sso/test', {
      ...settings(),
      issuer: `${provider.issuer}-inconnu`,
    })
    expect(wrongRealm.json()).toMatchObject({ ok: false })
    expect(wrongRealm.json().message).toMatch(/injoignable ou adresse incorrecte/)
  })

  it('active le SSO à chaud, sans redémarrage, et garde le secret caché', async () => {
    const saved = await call('PUT', '/settings/sso', settings())
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ source: 'settings', enabled: true, hasSecret: true })
    expect(JSON.stringify(saved.json())).not.toContain(CLIENT_SECRET)

    const config = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(config.json()).toMatchObject({ oidcEnabled: true, oidcProviderName: 'Keycloak maison' })

    // Connexion SSO complète.
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' })
    expect(start.statusCode).toBe(302)
    const done = await app.inject({
      method: 'GET',
      url: provider.authorize(start.headers.location as string, ALICE),
      headers: { cookie: cookieValue(start, '__Secure-vercio_oidc') },
    })
    expect(done.statusCode).toBe(302)
    expect(done.headers.location).toBe('/')
    expect(done.cookies.find((c) => c.name === '__Host-vercio_session')).toBeDefined()
  })

  it('garde le secret enregistré quand il est laissé vide', async () => {
    const saved = await call('PUT', '/settings/sso', {
      ...settings(),
      clientSecret: '',
      providerName: 'SSO',
    })
    expect(saved.json()).toMatchObject({ hasSecret: true, providerName: 'SSO' })
    const test = await call('POST', '/settings/sso/test', { ...settings(), clientSecret: '' })
    expect(test.json()).toMatchObject({ ok: true })
  })

  it('refuse de couper le SSO depuis une session SSO', async () => {
    const ssoAdmin = await sessionFor('oidc', 'admin-sso', ['vercio-admin'])
    const refused = await call('PUT', '/settings/sso', { ...settings(), enabled: false }, ssoAdmin)
    expect(refused.statusCode).toBe(409)
    expect((await call('DELETE', '/settings/sso', undefined, ssoAdmin)).statusCode).toBe(409)
  })

  it('désactivé : bouton retiré et sessions SSO fermées', async () => {
    const off = await call('PUT', '/settings/sso', { ...settings(), enabled: false })
    expect(off.json()).toMatchObject({ enabled: false })
    const config = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(config.json()).toMatchObject({ oidcEnabled: false })
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/login' })).statusCode).toBe(404)

    const ssoSessions = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(users.provider, 'oidc'))
    expect(ssoSessions).toHaveLength(0)
  })
})

describe.skipIf(!TEST_DATABASE_URL)('API — SSO défini dans le .env', () => {
  it('le .env prime : page en lecture seule, enregistrement refusé', async () => {
    const provider = await startFakeOidcProvider('vercio')
    const { app, db, close } = await setupTestApp({
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: 'vercio',
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
    })
    try {
      const [user] = await db
        .insert(users)
        .values({
          provider: 'local',
          subject: 'a',
          username: 'a',
          displayName: 'a',
          roles: ['vercio-admin'],
        })
        .returning()
      const { token } = await new SessionStore(db, 3_600_000).create(user!.id, {})
      const headers = { cookie: `__Host-vercio_session=${token}`, origin: ORIGIN }
      const view = await app.inject({ method: 'GET', url: '/api/settings/sso', headers })
      expect(view.json()).toMatchObject({ source: 'env', enabled: true, issuer: provider.issuer })
      expect(JSON.stringify(view.json())).not.toContain(CLIENT_SECRET)
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings/sso',
        headers,
        payload: {
          enabled: false,
          issuer: provider.issuer,
          clientId: 'vercio',
          providerName: 'x',
          scopes: 'openid',
          rolesClaims: 'groups',
        },
      })
      expect(put.statusCode).toBe(409)
    } finally {
      await close()
      await provider.close()
    }
  })
})
