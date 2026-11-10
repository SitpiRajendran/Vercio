import { eq } from 'drizzle-orm'
import * as client from 'openid-client'
import { SSO_DEFAULTS, type ConnectionCheck, type SsoSettingsView } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSettings } from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { describeNetworkError } from '../lib/http.js'
import { OidcService } from './oidc.js'

export const SSO_SETTINGS_KEY = 'sso'

/** Réglages enregistrés depuis l'interface (secret chiffré). */
interface StoredSso {
  enabled: boolean
  issuer: string
  clientId: string
  clientSecretEnc: string
  providerName: string
  scopes: string
  rolesClaims: string
}

/** Variables OIDC_* du .env : quand OIDC_ISSUER est défini, elles priment sur l'interface. */
export interface SsoEnv {
  issuer?: string
  clientId?: string
  clientSecret?: string
  scopes: string
  rolesClaims: string
  providerName: string
}

export interface SsoDraft {
  issuer: string
  clientId: string
  clientSecret?: string
  scopes: string
}

export interface ActiveSso {
  service: OidcService
  providerName: string
}

export class SsoSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message)
  }
}

/**
 * SSO OpenID Connect en service. Configuré par le .env (prioritaire) ou depuis l'interface ;
 * un enregistrement depuis l'interface s'applique tout de suite, sans redémarrer Vercio.
 */
export class SsoManager {
  #active: ActiveSso | null = null

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly env: SsoEnv,
    private readonly publicUrl: URL,
    private readonly localAuth: boolean,
  ) {}

  get fromEnv(): boolean {
    return Boolean(this.env.issuer)
  }

  current(): ActiveSso | null {
    return this.#active
  }

  urls() {
    return {
      redirectUri: new URL('/api/auth/oidc/callback', this.publicUrl).href,
      postLogoutRedirectUri: new URL('/connexion', this.publicUrl).href,
      backchannelLogoutUri: new URL('/api/auth/oidc/backchannel-logout', this.publicUrl).href,
    }
  }

  private build(settings: {
    issuer: string
    clientId: string
    clientSecret: string
    scopes: string
    rolesClaims: string
  }): OidcService {
    const { redirectUri, postLogoutRedirectUri } = this.urls()
    return new OidcService({ ...settings, redirectUri, postLogoutRedirectUri })
  }

  /** (Re)lit la configuration : .env d'abord, sinon les réglages enregistrés. */
  async load(): Promise<void> {
    if (this.fromEnv) {
      this.#active = {
        service: this.build({
          issuer: this.env.issuer!,
          clientId: this.env.clientId!,
          clientSecret: this.env.clientSecret!,
          scopes: this.env.scopes,
          rolesClaims: this.env.rolesClaims,
        }),
        providerName: this.env.providerName,
      }
      return
    }
    const stored = await this.stored()
    this.#active =
      stored?.enabled === true
        ? {
            service: this.build({
              issuer: stored.issuer,
              clientId: stored.clientId,
              clientSecret: this.box.decrypt(stored.clientSecretEnc),
              scopes: stored.scopes,
              rolesClaims: stored.rolesClaims,
            }),
            providerName: stored.providerName,
          }
        : null
  }

  private async stored(): Promise<StoredSso | null> {
    const [row] = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SSO_SETTINGS_KEY))
    return (row?.value as StoredSso | undefined) ?? null
  }

  async view(): Promise<SsoSettingsView> {
    const urls = this.urls()
    const base = { ...urls, localAuth: this.localAuth }
    if (this.fromEnv) {
      return {
        ...base,
        source: 'env',
        enabled: true,
        issuer: this.env.issuer!,
        clientId: this.env.clientId!,
        hasSecret: true,
        providerName: this.env.providerName,
        scopes: this.env.scopes,
        rolesClaims: this.env.rolesClaims,
      }
    }
    const stored = await this.stored()
    if (!stored) {
      return {
        ...base,
        source: 'none',
        enabled: false,
        issuer: '',
        clientId: 'vercio',
        hasSecret: false,
        ...SSO_DEFAULTS,
      }
    }
    const { clientSecretEnc, ...rest } = stored
    return { ...base, ...rest, source: 'settings', hasSecret: Boolean(clientSecretEnc) }
  }

  /** Secret saisi, ou celui déjà enregistré pour le même client. */
  private async secretFor(draft: SsoDraft): Promise<string> {
    if (draft.clientSecret) return draft.clientSecret
    const stored = await this.stored()
    if (stored?.clientSecretEnc) return this.box.decrypt(stored.clientSecretEnc)
    throw new SsoSettingsError('Secret du client requis', 400, 'clientSecret')
  }

  async save(input: SsoDraft & Omit<StoredSso, 'clientSecretEnc' | keyof SsoDraft>) {
    if (this.fromEnv) {
      throw new SsoSettingsError(
        'SSO défini dans le fichier .env (variables OIDC_*) : modifiez-le là, ou retirez ces variables pour le gérer ici',
        409,
      )
    }
    const secret = await this.secretFor(input)
    const value: StoredSso = {
      enabled: input.enabled,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEnc: this.box.encrypt(secret),
      providerName: input.providerName,
      scopes: input.scopes,
      rolesClaims: input.rolesClaims,
    }
    await this.db
      .insert(appSettings)
      .values({ key: SSO_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    await this.load()
  }

  async remove(): Promise<void> {
    if (this.fromEnv) throw new SsoSettingsError('SSO défini dans le fichier .env', 409)
    await this.db.delete(appSettings).where(eq(appSettings.key, SSO_SETTINGS_KEY))
    await this.load()
  }

  /**
   * Vérifie un brouillon : découverte OpenID (adresse du realm), puis identifiants du client
   * par une demande de jeton « client credentials ». Keycloak répond `unauthorized_client`
   * quand le client est correct mais sans compte de service : c'est le cas normal.
   */
  async test(draft: SsoDraft): Promise<ConnectionCheck> {
    const checkedAt = new Date().toISOString()
    const details: ConnectionCheck['details'] = []
    const warnings: string[] = []
    const secret = await this.secretFor(draft)
    const issuer = new URL(draft.issuer)
    let config: client.Configuration
    try {
      config = await client.discovery(issuer, draft.clientId, secret, undefined, {
        execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
        timeout: 10,
      })
    } catch (error) {
      return {
        ok: false,
        message: `Fournisseur injoignable ou adresse incorrecte : ${describeError(error)}. L’adresse attendue est celle du realm, par exemple https://keycloak.exemple.fr/realms/mon-realm.`,
        details,
        warnings,
        checkedAt,
      }
    }
    const metadata = config.serverMetadata()
    details.push({ label: 'Émetteur', value: metadata.issuer })
    if (issuer.protocol === 'http:')
      warnings.push('Fournisseur en http : à réserver à un réseau interne')
    if (!metadata.end_session_endpoint) {
      warnings.push('Pas de déconnexion côté fournisseur (end_session_endpoint absent)')
    }
    if (!metadata.backchannel_logout_supported) {
      warnings.push('Déconnexion back-channel non annoncée par le fournisseur')
    }

    try {
      await client.clientCredentialsGrant(config)
      details.push({ label: 'Client', value: `${draft.clientId} (identifiants acceptés)` })
    } catch (error) {
      const code = (error as { error?: string }).error
      if (code === 'invalid_client' || code === 'unauthorized') {
        return {
          ok: false,
          message: `Client « ${draft.clientId} » ou secret refusé par le fournisseur`,
          details,
          warnings,
          checkedAt,
        }
      }
      if (code === 'unauthorized_client') {
        details.push({ label: 'Client', value: `${draft.clientId} (identifiants acceptés)` })
      } else {
        warnings.push(`Secret non vérifié : ${describeError(error)}`)
      }
    }
    return {
      ok: true,
      message: `${metadata.issuer} répond, le client est reconnu`,
      details,
      warnings,
      checkedAt,
    }
  }
}

function describeError(error: unknown): string {
  const body = error as { error?: string; error_description?: string; message?: string }
  if (body?.error)
    return body.error_description ? `${body.error} (${body.error_description})` : body.error
  return describeNetworkError(error)
}
