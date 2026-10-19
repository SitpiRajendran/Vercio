import * as client from 'openid-client'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { roleSchema, type Role } from '@vercio/shared'

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
  rolesClaims: string
  redirectUri: string
  postLogoutRedirectUri: string
}

export interface PendingLogin {
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcIdentity {
  subject: string
  username: string
  displayName: string
  email: string | null
  roles: Role[]
  sid: string | null
  idToken: string
}

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

/**
 * Client OpenID Connect (Authorization Code + PKCE).
 * La découverte est paresseuse : Vercio démarre même si Keycloak est momentanément injoignable.
 */
export class OidcService {
  #config: Promise<client.Configuration> | null = null
  #jwks: JWTVerifyGetKey | null = null

  constructor(private readonly settings: OidcSettings) {}

  private configuration(): Promise<client.Configuration> {
    if (!this.#config) {
      const issuer = new URL(this.settings.issuer)
      this.#config = client
        .discovery(issuer, this.settings.clientId, this.settings.clientSecret, undefined, {
          // Autorisé uniquement pour un émetteur en http (développement, réseau interne).
          execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
        })
        .catch((error: unknown) => {
          this.#config = null
          throw error
        })
    }
    return this.#config
  }

  async startLogin(): Promise<{ url: string; pending: PendingLogin }> {
    const config = await this.configuration()
    const pending: PendingLogin = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    }
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.redirectUri,
      scope: this.settings.scopes,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: 'S256',
    })
    return { url: url.href, pending }
  }

  async finishLogin(callbackUrl: URL, pending: PendingLogin): Promise<OidcIdentity> {
    const config = await this.configuration()
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    if (!claims || !tokens.id_token) throw new Error('ID token absent')

    // Les rôles peuvent être dans l'ID token ou seulement dans l'access token (Keycloak).
    const accessClaims = decodeJwtPayload(tokens.access_token)
    const roles = extractRoles(
      [claims, accessClaims],
      this.settings.rolesClaims,
      this.settings.clientId,
    )

    const username = stringClaim(claims, 'preferred_username') ?? claims.sub
    return {
      subject: claims.sub,
      username,
      displayName: stringClaim(claims, 'name') ?? username,
      email: stringClaim(claims, 'email'),
      roles,
      sid: stringClaim(claims, 'sid'),
      idToken: tokens.id_token,
    }
  }

  async endSessionUrl(idToken: string | null): Promise<string | null> {
    const config = await this.configuration()
    if (!config.serverMetadata().end_session_endpoint) return null
    const params: Record<string, string> = {
      client_id: this.settings.clientId,
      post_logout_redirect_uri: this.settings.postLogoutRedirectUri,
    }
    if (idToken) params.id_token_hint = idToken
    return client.buildEndSessionUrl(config, params).href
  }

  /** Vérifie un `logout_token` reçu en déconnexion back-channel (OIDC Back-Channel Logout 1.0). */
  async verifyLogoutToken(token: string): Promise<{ sid: string | null; sub: string | null }> {
    const config = await this.configuration()
    const metadata = config.serverMetadata()
    if (!metadata.jwks_uri) throw new Error('jwks_uri absent')
    this.#jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri))

    const { payload } = await jwtVerify(token, this.#jwks, {
      issuer: metadata.issuer,
      audience: this.settings.clientId,
      maxTokenAge: '5 minutes',
    })
    const events = payload.events as Record<string, unknown> | undefined
    if (!events || typeof events !== 'object' || !(BACKCHANNEL_LOGOUT_EVENT in events)) {
      throw new Error('Événement de déconnexion absent')
    }
    if ('nonce' in payload) throw new Error('Un logout_token ne doit pas contenir de nonce')
    const sid = typeof payload.sid === 'string' ? payload.sid : null
    const sub = typeof payload.sub === 'string' ? payload.sub : null
    if (!sid && !sub) throw new Error('sid ou sub requis')
    return { sid, sub }
  }
}

/**
 * Lit les rôles `vercio-*` dans les revendications configurées (chemins pointés).
 * Groupes Keycloak : seul un groupe à la racine (`/vercio-admin`) donne le rôle du même nom.
 */
export function extractRoles(
  sources: (Record<string, unknown> | null)[],
  claimPaths: string,
  clientId: string,
): Role[] {
  const roles = new Set<Role>()
  const paths = claimPaths
    .split(',')
    .map((path) => path.trim().replaceAll('{clientId}', clientId))
    .filter(Boolean)

  for (const source of sources) {
    if (!source) continue
    for (const path of paths) {
      const value = readPath(source, path)
      const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
      for (const entry of values) {
        if (typeof entry !== 'string') continue
        // Nom exact, ou groupe à la racine (`/vercio-admin`) : jamais le dernier segment d'un
        // chemin, qu'un utilisateur pourrait créer lui-même (`mon-groupe/vercio-admin`).
        const name = entry.startsWith('/') && entry.lastIndexOf('/') === 0 ? entry.slice(1) : entry
        const parsed = roleSchema.safeParse(name)
        if (parsed.success) roles.add(parsed.data)
      }
    }
  }
  return [...roles]
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  // Les identifiants de client peuvent contenir des points : on essaie d'abord la clé entière.
  let current: unknown = source
  const parts = path.split('.')
  for (let i = 0; i < parts.length; i++) {
    if (!current || typeof current !== 'object') return undefined
    const record = current as Record<string, unknown>
    let matched = false
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join('.')
      if (key in record) {
        current = record[key]
        i = j - 1
        matched = true
        break
      }
    }
    if (!matched) return undefined
  }
  return current
}

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Lecture sans vérification : l'access token vient d'être reçu directement du fournisseur. */
function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
