import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { extractRoles } from '../src/auth/oidc.js'
import { cookieValue, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'
import { startFakeOidcProvider, type FakeUser } from './oidc-provider.js'

describe('extractRoles', () => {
  it('lit les rôles du client, du realm et des groupes', () => {
    const roles = extractRoles(
      [
        {
          resource_access: { 'vercio.app': { roles: ['vercio-deployer', 'autre'] } },
          realm_access: { roles: ['vercio-viewer'] },
          groups: ['/vercio-admin', '/autre'],
        },
      ],
      'resource_access.{clientId}.roles,realm_access.roles,groups',
      'vercio.app',
    )
    expect(roles.sort()).toEqual(['vercio-admin', 'vercio-deployer', 'vercio-viewer'])
  })

  it('ne donne jamais un rôle par le dernier segment d’un chemin de groupe', () => {
    // GitLab, ou tout fournisseur où l'on crée ses groupes : `mon-groupe/vercio-admin`.
    expect(
      extractRoles(
        [{ groups: ['mon-groupe/vercio-admin', '/equipe/vercio-admin'] }],
        'groups',
        'x',
      ),
    ).toEqual([])
  })

  it('ignore les rôles inconnus et les revendications absentes', () => {
    expect(extractRoles([{ groups: ['admin'] }, null], 'groups,absent.path', 'x')).toEqual([])
  })
})

const ALICE: FakeUser = {
  sub: 'alice-sub',
  sid: 'session-alice',
  username: 'alice',
  name: 'Alice Martin',
  email: 'alice@example.com',
  clientRoles: ['vercio-deployer'],
}

describe.skipIf(!TEST_DATABASE_URL)('API — SSO OIDC', () => {
  let app: FastifyInstance
  let close: () => Promise<void>
  let provider: Awaited<ReturnType<typeof startFakeOidcProvider>>

  beforeAll(async () => {
    provider = await startFakeOidcProvider('vercio')
    ;({ app, close } = await setupTestApp({
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: 'vercio',
      OIDC_CLIENT_SECRET: 'secret',
    }))
  })

  afterAll(async () => {
    await close?.()
    await provider?.close()
  })

  async function ssoLogin(user: FakeUser) {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' })
    expect(start.statusCode).toBe(302)
    const authorizationUrl = start.headers.location as string
    expect(authorizationUrl.startsWith(provider.issuer)).toBe(true)
    const url = new URL(authorizationUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/oidc/callback`)

    return app.inject({
      method: 'GET',
      url: provider.authorize(authorizationUrl, user),
      headers: { cookie: cookieValue(start, '__Secure-vercio_oidc') },
    })
  }

  it('annonce le SSO', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(response.json()).toMatchObject({ oidcEnabled: true, oidcProviderName: 'Keycloak' })
  })

  it('connecte un utilisateur Keycloak avec ses rôles', async () => {
    const callback = await ssoLogin(ALICE)
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/')
    const cookie = cookieValue(callback, '__Host-vercio_session')

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.json()).toMatchObject({
      username: 'alice',
      displayName: 'Alice Martin',
      email: 'alice@example.com',
      roles: ['vercio-deployer'],
      provider: 'oidc',
    })
  })

  it('met à jour les rôles à chaque connexion', async () => {
    const callback = await ssoLogin({ ...ALICE, clientRoles: ['vercio-admin'] })
    const cookie = cookieValue(callback, '__Host-vercio_session')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.json()).toMatchObject({ roles: ['vercio-admin'] })
  })

  it('refuse un utilisateur sans rôle Vercio', async () => {
    const callback = await ssoLogin({ ...ALICE, sub: 'bob', username: 'bob', clientRoles: [] })
    expect(callback.headers.location).toBe('/connexion?erreur=no_role')
    expect(callback.cookies.find((c) => c.name === '__Host-vercio_session')).toBeUndefined()
  })

  it('refuse un retour sans état de connexion (CSRF)', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' })
    const callbackUrl = provider.authorize(start.headers.location as string, ALICE)
    const callback = await app.inject({ method: 'GET', url: callbackUrl })
    expect(callback.headers.location).toBe('/connexion?erreur=failed')
  })

  it('refuse un état falsifié', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' })
    const callbackUrl = provider
      .authorize(start.headers.location as string, ALICE)
      .replace(/state=[^&]+/, 'state=falsifie')
    const callback = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { cookie: cookieValue(start, '__Secure-vercio_oidc') },
    })
    expect(callback.headers.location).toBe('/connexion?erreur=failed')
  })

  it('renvoie vers Keycloak à la déconnexion', async () => {
    const cookie = cookieValue(await ssoLogin(ALICE), '__Host-vercio_session')
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: ORIGIN },
    })
    const { redirectTo } = logout.json<{ redirectTo: string }>()
    const url = new URL(redirectTo)
    expect(url.href.startsWith(`${provider.issuer}/logout`)).toBe(true)
    expect(url.searchParams.get('id_token_hint')).toBeTruthy()
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/connexion`)
  })

  it('ferme la session sur déconnexion back-channel', async () => {
    const cookie = cookieValue(await ssoLogin(ALICE), '__Host-vercio_session')
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        logout_token: await provider.logoutToken({ sid: ALICE.sid }),
      }).toString(),
    })
    expect(response.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })

  it('refuse un logout_token invalide', async () => {
    const cookie = cookieValue(await ssoLogin(ALICE), '__Host-vercio_session')
    const forged = await provider.logoutToken({ sid: ALICE.sid }, { aud: 'autre-client' })
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `logout_token=${forged}`,
    })
    expect(response.statusCode).toBe(400)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
  })
})
