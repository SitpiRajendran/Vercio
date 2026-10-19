import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'

/**
 * Fournisseur OIDC minimal pour les tests (comportement aligné sur Keycloak) :
 * découverte, JWKS, échange de code avec PKCE, ID token et access token signés en RS256.
 */
export async function startFakeOidcProvider(clientId: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, { nonce: string; challenge: string; user: FakeUser }>()

  const server = Fastify()
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  )
  // Connu une fois le port attribué ; les routes le lisent à chaque requête.
  let issuer = ''

  server.get('/realms/test/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/certs`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }))

  server.get('/realms/test/certs', async () => ({ keys: [jwk] }))

  server.post('/realms/test/token', async (request, reply) => {
    const body = request.body as Record<string, string>
    const entry = body.code ? codes.get(body.code) : undefined
    if (!entry || !body.code_verifier) return reply.code(400).send({ error: 'invalid_grant' })
    const challenge = createHash('sha256').update(body.code_verifier).digest('base64url')
    if (challenge !== entry.challenge) return reply.code(400).send({ error: 'invalid_grant' })
    codes.delete(body.code!)

    const { user } = entry
    const common = { iss: issuer, sub: user.sub, sid: user.sid }
    const idToken = await sign(privateKey, {
      ...common,
      aud: clientId,
      nonce: entry.nonce,
      preferred_username: user.username,
      name: user.name,
      email: user.email,
    })
    const accessToken = await sign(privateKey, {
      ...common,
      aud: 'account',
      resource_access: { [clientId]: { roles: user.clientRoles } },
      realm_access: { roles: ['offline_access'] },
    })
    return {
      access_token: accessToken,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 300,
    }
  })

  await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address()
  if (!address || typeof address === 'string') throw new Error('adresse inconnue')
  issuer = `http://127.0.0.1:${address.port}/realms/test`

  return {
    issuer,
    /** Simule l'utilisateur qui s'authentifie sur la page Keycloak : renvoie l'URL de rappel. */
    authorize(authorizationUrl: string, user: FakeUser): string {
      const url = new URL(authorizationUrl)
      const code = randomUUID()
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        user,
      })
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      return callback.pathname + callback.search
    },
    logoutToken(claims: { sid?: string; sub?: string }, overrides: Record<string, unknown> = {}) {
      return sign(privateKey, {
        iss: issuer,
        aud: clientId,
        jti: randomUUID(),
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        ...claims,
        ...overrides,
      })
    },
    close: () => server.close(),
  }
}

export interface FakeUser {
  sub: string
  sid: string
  username: string
  name: string
  email: string
  clientRoles: string[]
}

function sign(key: CryptoKey, claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}
