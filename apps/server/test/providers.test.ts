import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitLabClient } from '../src/providers/gitlab.js'
import { OciRegistryClient, parseChallenge } from '../src/providers/registry.js'
import {
  GITLAB_TOKEN,
  REGISTRY_PASSWORD,
  REGISTRY_USER,
  startFakeGitLab,
  startFakeRegistry,
} from './fake-services.js'

describe('parseChallenge', () => {
  it('lit un challenge Bearer', () => {
    expect(
      parseChallenge('Bearer realm="https://gitlab.com/jwt/auth",service="container_registry"'),
    ).toEqual({
      scheme: 'bearer',
      params: { realm: 'https://gitlab.com/jwt/auth', service: 'container_registry' },
    })
  })
  it('lit un challenge Basic et ignore les autres', () => {
    expect(parseChallenge('Basic realm="Registry"')?.scheme).toBe('basic')
    expect(parseChallenge('Negotiate')).toBeNull()
    expect(parseChallenge(null)).toBeNull()
  })
})

describe('GitLabClient', () => {
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  beforeAll(async () => {
    gitlab = await startFakeGitLab()
  })
  afterAll(() => gitlab.close())

  it('valide un token et décrit la connexion', async () => {
    const result = await new GitLabClient({ url: gitlab.url, token: GITLAB_TOKEN }).check()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('vercio-bot')
    expect(result.details).toContainEqual({ label: 'Version de GitLab', value: '19.4.2' })
    expect(result.warnings.some((w) => w.includes('expire dans'))).toBe(true)
  })

  it('signale un token refusé', async () => {
    const result = await new GitLabClient({ url: gitlab.url, token: 'mauvais' }).check()
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Token refusé') })
  })

  it('signale une adresse sans API GitLab', async () => {
    const result = await new GitLabClient({
      url: `${gitlab.url}/autre`,
      token: GITLAB_TOKEN,
    }).check()
    expect(result.ok).toBe(false)
  })

  it('signale un hôte injoignable', async () => {
    const result = await new GitLabClient({ url: 'http://127.0.0.1:59999', token: 'x' }).check()
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Connexion refusée'),
    })
  })

  it('avertit des portées manquantes ou trop larges', async () => {
    const wide = await startFakeGitLab(['api'])
    const result = await new GitLabClient({ url: wide.url, token: GITLAB_TOKEN }).check()
    await wide.close()
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toContain('read_registry')
    expect(result.warnings.join(' ')).toContain('droits d’écriture')
  })
})

describe('OciRegistryClient', () => {
  it('suit le flux par jeton (Bearer)', async () => {
    const registry = await startFakeRegistry('bearer')
    const ok = await new OciRegistryClient({
      url: registry.url,
      username: REGISTRY_USER,
      password: REGISTRY_PASSWORD,
    }).check()
    const refused = await new OciRegistryClient({
      url: registry.url,
      username: REGISTRY_USER,
      password: 'mauvais',
    }).check()
    await registry.close()
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining(REGISTRY_USER) })
    expect(ok.details).toContainEqual({ label: 'Authentification', value: 'jeton (Bearer)' })
    expect(ok.warnings.join(' ')).toContain('HTTP non chiffrée')
    expect(refused).toMatchObject({ ok: false, message: 'Identifiants refusés par le registry' })
  })

  it('n’envoie pas les identifiants à un service de jetons d’un autre domaine', async () => {
    const { default: Fastify } = await import('fastify')
    const server = Fastify()
    const received: string[] = []
    server.get('/v2/', async (_request, reply) =>
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="http://jetons.ailleurs.example/token"')
        .send({}),
    )
    server.get('/token', async (request) => {
      received.push(request.headers.authorization ?? '')
      return { token: 'x' }
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address() as { port: number }
    const check = await new OciRegistryClient({
      url: `http://127.0.0.1:${address.port}`,
      username: REGISTRY_USER,
      password: REGISTRY_PASSWORD,
    }).check()
    await server.close()
    expect(check).toMatchObject({ ok: false })
    expect(check.message).toContain('autre domaine')
    expect(received).toEqual([])
  })

  it('gère l’authentification Basic', async () => {
    const registry = await startFakeRegistry('basic')
    const ok = await new OciRegistryClient({
      url: registry.url,
      username: REGISTRY_USER,
      password: REGISTRY_PASSWORD,
    }).check()
    const missing = await new OciRegistryClient({ url: registry.url }).check()
    await registry.close()
    expect(ok.ok).toBe(true)
    expect(missing.message).toContain('exige un identifiant')
  })

  it('accepte un registry anonyme', async () => {
    const registry = await startFakeRegistry('anonymous')
    const result = await new OciRegistryClient({ url: registry.url }).check()
    await registry.close()
    expect(result).toMatchObject({ ok: true, message: 'Registry joignable (accès anonyme)' })
  })

  it('ajoute https par défaut et http en mode non sécurisé', () => {
    expect(new OciRegistryClient({ url: 'registry.example.com/' }).baseUrl).toBe(
      'https://registry.example.com',
    )
    expect(new OciRegistryClient({ url: 'registry.lan:5000', insecure: true }).baseUrl).toBe(
      'http://registry.lan:5000',
    )
  })
})

describe('describeNetworkError', async () => {
  const { describeNetworkError } = await import('../src/lib/http.js')
  const wrap = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause })

  it('traduit les erreurs courantes', () => {
    expect(describeNetworkError(wrap({ code: 'ENOTFOUND' }))).toContain('Hôte introuvable')
    expect(describeNetworkError(wrap({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toContain(
      'autorité interne',
    )
    expect(describeNetworkError(wrap({ code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG' }))).toContain(
      'ne parle peut-être pas HTTPS',
    )
  })

  it('reconnaît un échec au travers du proxy', () => {
    const error = wrap({
      code: 0,
      message: 'Request was cancelled.',
      cause: {
        code: 'UND_ERR_ABORTED',
        message: 'Proxy response (502) !== 200 when HTTP Tunneling',
      },
    })
    expect(describeNetworkError(error)).toContain('via le proxy HTTP (réponse 502)')
  })
})

describe('GitHubClient', async () => {
  const { GitHubClient } = await import('../src/providers/github.js')
  const { gitProviderApiUrl } = await import('@vercio/shared')
  const { startFakeGitHub, GITHUB_CLASSIC_TOKEN, GITHUB_FINE_TOKEN } =
    await import('./fake-services.js')

  it('déduit l’URL de l’API', () => {
    expect(gitProviderApiUrl('github', 'https://github.com')).toBe('https://api.github.com')
    expect(gitProviderApiUrl('github', 'https://github.example.com')).toBe(
      'https://github.example.com/api/v3',
    )
    expect(gitProviderApiUrl('gitlab', 'https://gitlab.com')).toBe('https://gitlab.com/api/v4')
  })

  it('valide un token classique et contrôle ses portées', async () => {
    const github = await startFakeGitHub({ enterprise: true })
    const result = await new GitHubClient({ url: github.url, token: GITHUB_CLASSIC_TOKEN }).check()
    await github.close()
    expect(result).toMatchObject({ ok: true, message: 'Connecté à GitHub en tant que vercio-bot' })
    expect(result.details).toContainEqual({
      label: 'Instance',
      value: 'GitHub Enterprise Server 3.17.2',
    })
    expect(result.details).toContainEqual({ label: 'Portées', value: 'repo, read:packages' })
    expect(result.warnings.join(' ')).toContain('donne aussi l’écriture')
  })

  it('signale l’absence de read:packages', async () => {
    const github = await startFakeGitHub({ scopes: 'repo' })
    const result = await new GitHubClient({ url: github.url, token: GITHUB_CLASSIC_TOKEN }).check()
    await github.close()
    expect(result.warnings.join(' ')).toContain('read:packages absente')
  })

  it('explique les limites d’un token fine-grained', async () => {
    const github = await startFakeGitHub()
    const result = await new GitHubClient({ url: github.url, token: GITHUB_FINE_TOKEN }).check()
    await github.close()
    expect(result.ok).toBe(true)
    expect(result.details).toContainEqual({ label: 'Type de token', value: 'fine-grained' })
    expect(result.warnings.join(' ')).toContain('ne donne pas accès à GHCR')
  })

  it('signale un token refusé', async () => {
    const github = await startFakeGitHub()
    const result = await new GitHubClient({ url: github.url, token: 'ghp_faux' }).check()
    await github.close()
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Token refusé') })
  })

  it('crée puis met à jour le webhook du dépôt (workflow_run, secret)', async () => {
    const github = await startFakeGitHub({ scopes: 'repo, admin:repo_hook' })
    const client = new GitHubClient({ url: github.url, token: GITHUB_CLASSIC_TOKEN })
    const { id } = await client.installWebhook('Acme/blog', {
      url: 'https://vercio.example.com/api/hooks/github/abc',
      secret: 's1',
    })
    const again = await client.installWebhook('Acme/blog', {
      url: 'https://vercio.example.com/api/hooks/github/def',
      secret: 's2',
      existingId: id,
    })
    expect(again.id).toBe(id)
    expect([...github.hooks.values()]).toEqual([
      expect.objectContaining({
        id: Number(id),
        events: ['workflow_run'],
        config: expect.objectContaining({
          url: 'https://vercio.example.com/api/hooks/github/def',
          secret: 's2',
          content_type: 'json',
        }),
      }),
    ])
    await github.close()
  })

  it('explique le refus d’un token sans admin:repo_hook', async () => {
    const github = await startFakeGitHub()
    const client = new GitHubClient({ url: github.url, token: GITHUB_FINE_TOKEN })
    await expect(
      client.installWebhook('Acme/blog', { url: 'https://vercio.example.com/x', secret: 's' }),
    ).rejects.toThrow('admin:repo_hook')
    await github.close()
  })
})

describe('OciRegistryClient — accès anonyme refusé', () => {
  it('explique qu’il faut des identifiants', async () => {
    const registry = await startFakeRegistry('bearer')
    const result = await new OciRegistryClient({ url: registry.url }).check()
    await registry.close()
    expect(result.message).toContain('n’autorise pas l’accès anonyme')
  })
})
