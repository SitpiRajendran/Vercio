import { isIP } from 'node:net'
import type { ConnectionCheck } from '@vercio/shared'
import { hashToken } from '../lib/crypto.js'
import { describeNetworkError, httpRequest, type HttpOptions } from '../lib/http.js'
import { CheckReport } from './check.js'

export interface RegistrySettings extends HttpOptions {
  /** Hôte du registry, avec ou sans schéma : registry.gitlab.com, https://harbor.example.com:8443 */
  url: string
  username?: string | null
  password?: string | null
  /** Autorise le HTTP sans TLS (réseau interne uniquement). */
  insecure?: boolean
}

export class RegistryError extends Error {}

export interface ImageTagInfo {
  digest: string
  createdAt: string | null
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** Date de création par digest de configuration : un digest ne change jamais. */
const createdCache = new Map<string, string | null>()
const CREATED_CACHE_MAX = 5000
/** Jetons Bearer par registry et portée, réutilisés quelques secondes. */
const tokenCache = new Map<string, { value: string | null; expiresAt: number }>()

interface Challenge {
  scheme: 'bearer' | 'basic'
  params: Record<string, string>
}

/**
 * Client d'un registry compatible OCI / Docker Registry v2 :
 * registry:2, Harbor, Nexus, GitLab Container Registry, Docker Hub…
 * Gère l'authentification Basic et le flux par jeton (challenge `WWW-Authenticate: Bearer`).
 */
export class OciRegistryClient {
  constructor(private readonly settings: RegistrySettings) {}

  get baseUrl(): string {
    const { url, insecure } = this.settings
    if (/^https?:\/\//.test(url)) return url.replace(/\/+$/, '')
    return `${insecure ? 'http' : 'https'}://${url.replace(/\/+$/, '')}`
  }

  private basicAuth(): string | null {
    const { username, password } = this.settings
    if (!password) return null
    return `Basic ${Buffer.from(`${username ?? ''}:${password}`).toString('base64')}`
  }

  /**
   * En-tête Authorization pour une portée donnée (ex. `repository:groupe/app:pull`),
   * ou `null` si le registry est anonyme.
   */
  async authorize(scope?: string): Promise<string | null> {
    const secret = this.settings.password ? hashToken(this.settings.password) : ''
    const cacheKey = `${this.baseUrl}|${this.settings.username ?? ''}|${secret}|${scope ?? ''}`
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const value = await this.requestAuthorization(scope)
    tokenCache.set(cacheKey, { value, expiresAt: Date.now() + 45_000 })
    return value
  }

  /**
   * Tags d'un dépôt d'images, ou `null` si le dépôt n'existe pas à ce chemin.
   * Sert au diagnostic quand un tag attendu est introuvable.
   */
  async listTags(path: string): Promise<string[] | null> {
    const authorization = await this.authorize(`repository:${path}:pull`)
    const response = await httpRequest(
      `${this.baseUrl}/v2/${path}/tags/list?n=1000`,
      { headers: authorization ? { Authorization: authorization } : {} },
      this.settings,
    )
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(`Accès refusé à l’image ${path}`)
    }
    if (!response.ok)
      throw new RegistryError(`Le registry a répondu ${response.status} pour ${path}`)
    const body = (await response.json()) as { tags?: string[] | null }
    return body.tags ?? []
  }

  /**
   * Tag d'une image : digest et date de création, ou `null` si le tag n'existe pas.
   * `path` est le chemin de l'image dans le registry (groupe/projet/front).
   */
  async getTag(path: string, tag: string): Promise<ImageTagInfo | null> {
    const authorization = await this.authorize(`repository:${path}:pull`)
    const headers: Record<string, string> = { Accept: MANIFEST_TYPES }
    if (authorization) headers.Authorization = authorization

    const response = await httpRequest(
      `${this.baseUrl}/v2/${path}/manifests/${encodeURIComponent(tag)}`,
      { headers },
      this.settings,
    )
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(`Accès refusé à l’image ${path}`)
    }
    if (!response.ok)
      throw new RegistryError(`Le registry a répondu ${response.status} pour ${path}:${tag}`)
    const digest = response.headers.get('docker-content-digest')
    const manifest = (await response.json()) as {
      manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]
      config?: { digest: string }
    }
    if (!digest) throw new RegistryError('Le registry n’a pas renvoyé le digest de l’image')
    return { digest, createdAt: await this.createdAt(path, manifest, headers) }
  }

  private async createdAt(
    path: string,
    manifest: {
      manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]
      config?: { digest: string }
    },
    headers: Record<string, string>,
  ): Promise<string | null> {
    let configDigest = manifest.config?.digest
    if (!configDigest && manifest.manifests?.length) {
      // Image multi-architecture : on lit la variante linux/amd64, sinon la première.
      const entry =
        manifest.manifests.find(
          (m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64',
        ) ?? manifest.manifests[0]!
      const child = await httpRequest(
        `${this.baseUrl}/v2/${path}/manifests/${entry.digest}`,
        { headers },
        this.settings,
      )
      if (!child.ok) return null
      configDigest = ((await child.json()) as { config?: { digest: string } }).config?.digest
    }
    if (!configDigest) return null
    if (createdCache.has(configDigest)) return createdCache.get(configDigest) ?? null

    const blobHeaders: Record<string, string> = headers.Authorization
      ? { Authorization: headers.Authorization }
      : {}
    let blob = await httpRequest(
      `${this.baseUrl}/v2/${path}/blobs/${configDigest}`,
      { headers: blobHeaders },
      this.settings,
    )
    const location = blob.headers.get('location')
    if (blob.status >= 300 && blob.status < 400 && location) {
      // Stockage externe (S3, GCS…) : URL signée, sans l'en-tête Authorization du registry.
      blob = await httpRequest(new URL(location, this.baseUrl).href, {}, this.settings)
    }
    const created = blob.ok ? (((await blob.json()) as { created?: string }).created ?? null) : null
    if (createdCache.size >= CREATED_CACHE_MAX) createdCache.clear()
    createdCache.set(configDigest, created)
    return created
  }

  private async requestAuthorization(scope?: string): Promise<string | null> {
    const ping = await httpRequest(`${this.baseUrl}/v2/`, {}, this.settings)
    if (ping.ok) return null
    if (ping.status === 404) {
      throw new RegistryError('Pas d’API /v2/ à cette adresse : ce n’est pas un registry Docker')
    }
    if (ping.status !== 401) throw new RegistryError(`Le registry a répondu ${ping.status}`)

    const challenge = parseChallenge(ping.headers.get('www-authenticate'))
    if (!challenge) throw new RegistryError('Méthode d’authentification du registry non reconnue')

    const basic = this.basicAuth()
    if (challenge.scheme === 'basic') {
      if (!basic) throw new RegistryError('Le registry exige un identifiant et un mot de passe')
      return basic
    }

    const realm = challenge.params.realm
    if (!realm) throw new RegistryError('Challenge Bearer sans adresse de jeton (realm)')
    const tokenUrl = new URL(realm)
    // Le registry désigne lui-même où envoyer les identifiants : jamais en clair depuis un registry
    // HTTPS, ni vers un autre domaine que le sien.
    if (basic) {
      const registry = new URL(this.baseUrl)
      if (registry.protocol === 'https:' && tokenUrl.protocol !== 'https:') {
        throw new RegistryError('Le registry demande d’envoyer les identifiants sans chiffrement')
      }
      if (!sameSite(registry.hostname, tokenUrl.hostname)) {
        throw new RegistryError(
          `Service de jetons sur un autre domaine (${tokenUrl.hostname}) : identifiants non envoyés`,
        )
      }
    }
    if (challenge.params.service) tokenUrl.searchParams.set('service', challenge.params.service)
    if (scope) tokenUrl.searchParams.set('scope', scope)
    if (this.settings.username) tokenUrl.searchParams.set('account', this.settings.username)

    const response = await httpRequest(
      tokenUrl.href,
      { headers: basic ? { Authorization: basic } : {} },
      this.settings,
    )
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(
        basic
          ? 'Identifiants refusés par le registry'
          : 'Le registry n’autorise pas l’accès anonyme : renseignez un identifiant et un mot de passe',
      )
    }
    if (!response.ok) {
      throw new RegistryError(`Le service de jetons du registry a répondu ${response.status}`)
    }
    const body = (await response.json()) as { token?: string; access_token?: string }
    const token = body.token ?? body.access_token
    if (!token) throw new RegistryError('Le service de jetons n’a pas renvoyé de jeton')
    return `Bearer ${token}`
  }

  async check(): Promise<ConnectionCheck> {
    const report = new CheckReport()
    report.detail('Adresse', this.baseUrl)
    if (this.baseUrl.startsWith('http://')) {
      report.warn('Connexion HTTP non chiffrée : à réserver à un réseau interne de confiance.')
    }
    try {
      const authorization = await this.authorize()
      const response = await httpRequest(
        `${this.baseUrl}/v2/`,
        { headers: authorization ? { Authorization: authorization } : {} },
        this.settings,
      )
      if (response.status === 401) return report.fail('Identifiants refusés par le registry')
      if (!response.ok) return report.fail(`Le registry a répondu ${response.status}`)

      report.detail('API', response.headers.get('docker-distribution-api-version') ?? 'OCI v2')
      if (!authorization) {
        report.detail('Authentification', 'aucune (accès anonyme)')
        if (this.settings.password) {
          report.warn('Le registry est anonyme : les identifiants saisis ne sont pas utilisés.')
        }
        return report.ok('Registry joignable (accès anonyme)')
      }
      report.detail(
        'Authentification',
        authorization.startsWith('Bearer')
          ? 'jeton (Bearer)'
          : 'identifiant / mot de passe (Basic)',
      )
      return report.ok(
        this.settings.username
          ? `Connecté au registry en tant que ${this.settings.username}`
          : 'Connecté au registry',
      )
    } catch (error) {
      if (error instanceof RegistryError) return report.fail(error.message)
      const message = describeNetworkError(error)
      return report.fail(
        message.startsWith('Erreur TLS') && this.baseUrl.startsWith('https://')
          ? `${message}. Registry interne sans TLS ? Activez l’option « HTTP non chiffré ».`
          : message,
      )
    }
  }
}

/** Analyse `WWW-Authenticate: Bearer realm="…",service="…"`. */
export function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null
  const match = /^\s*(\w+)\s*(.*)$/.exec(header)
  if (!match) return null
  const scheme = match[1]!.toLowerCase()
  if (scheme !== 'bearer' && scheme !== 'basic') return null
  const params: Record<string, string> = {}
  for (const [, key, quoted, bare] of match[2]!.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[key!.toLowerCase()] = quoted ?? bare ?? ''
  }
  return { scheme, params }
}

/** Même site : même adresse IP, ou mêmes deux derniers éléments du nom (`docker.io`, `gitlab.com`). */
function sameSite(a: string, b: string): boolean {
  if (isIP(a) || isIP(b) || !a.includes('.') || !b.includes('.')) return a === b
  return a.split('.').slice(-2).join('.') === b.split('.').slice(-2).join('.')
}
