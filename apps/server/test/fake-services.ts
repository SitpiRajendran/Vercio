import Fastify, { type FastifyInstance } from 'fastify'

async function listen(server: FastifyInstance): Promise<string> {
  await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address()
  if (!address || typeof address === 'string') throw new Error('adresse inconnue')
  return `http://127.0.0.1:${address.port}`
}

export const GITLAB_TOKEN = 'glpat-test-token-1234'

export const SITE_COMPOSE = `services:
  front:
    image: registry.gitlab.example.com/acme/site/front:latest
    ports: ["8080:80"]
  back:
    image: registry.gitlab.example.com/acme/site/back:latest
    env_file: .env
  redis:
    image: redis:7
`

/** API GitLab v4 minimale : /user, /version, /personal_access_tokens/self. */
export async function startFakeGitLab(scopes = ['read_api', 'read_registry']) {
  const server = Fastify()
  server.addHook('onRequest', async (request, reply) => {
    if (request.headers['private-token'] !== GITLAB_TOKEN) {
      return reply.code(401).send({ message: '401 Unauthorized' })
    }
  })
  server.get('/api/v4/user', async () => ({ username: 'vercio-bot', name: 'Vercio', bot: false }))
  server.get('/api/v4/version', async () => ({ version: '19.4.2', revision: 'abc' }))
  server.get('/api/v4/projects', async (request) => {
    const search = (request.query as { search?: string }).search ?? ''
    return [
      {
        path_with_namespace: 'acme/site',
        name: 'site',
        default_branch: 'main',
        web_url: 'https://gitlab.example.com/acme/site',
        visibility: 'private',
      },
      {
        path_with_namespace: 'acme/api',
        name: 'api',
        default_branch: 'develop',
        web_url: 'https://gitlab.example.com/acme/api',
        visibility: 'internal',
      },
    ].filter((project) => project.path_with_namespace.includes(search))
  })
  server.get('/api/v4/projects/:id/repository/branches', async (request, reply) => {
    if ((request.params as { id: string }).id !== 'acme/site') return reply.code(404).send({})
    return [
      { name: 'main', default: true },
      { name: 'develop', default: false },
    ]
  })
  server.get('/api/v4/projects/:id/repository/files/:path/raw', async (request, reply) => {
    const { id, path } = request.params as { id: string; path: string }
    const { ref } = request.query as { ref: string }
    if (id !== 'acme/site' || path !== 'docker-compose.yml' || ref !== 'main') {
      return reply.code(404).send({ message: '404 File Not Found' })
    }
    reply.type('text/plain')
    return SITE_COMPOSE
  })
  server.get('/api/v4/projects/:id/repository/tree', async (request) => {
    const { page } = request.query as { page?: string }
    // Deux pages : la première pleine (100 entrées), pour vérifier la pagination.
    if (page === '2') return [{ path: 'deploy/compose.prod.yml', type: 'blob' }]
    return [
      { path: 'docker-compose.yml', type: 'blob' },
      { path: 'deploy', type: 'tree' },
      ...Array.from({ length: 98 }, (_, index) => ({ path: `src/file${index}.ts`, type: 'blob' })),
    ]
  })
  server.get('/api/v4/projects/:id/repository/tags', async () =>
    ['v1.4', 'v1.3', 'v1.2', 'v1.1', 'v1.0', 'v0.9', 'experimental'].map((name, index) => ({
      name,
      commit: {
        id: `${name}-sha-0000000000`,
        title: `Version ${name}`,
        author_name: 'Alice',
        created_at: `2026-02-${String(20 - index).padStart(2, '0')}T10:00:00Z`,
      },
    })),
  )
  server.get('/api/v4/projects/:id/repository/commits', async () =>
    // Du plus récent au plus ancien ; seuls aaaa… et bbbb… ont une image (voir versions-api).
    ['aaaaaaaa', 'cccccccc', 'bbbbbbbb'].map((prefix, index) => ({
      id: `${prefix}${'0'.repeat(32)}`,
      title: `Commit ${prefix}`,
      author_name: 'Bob',
      committed_date: `2026-03-0${3 - index}T10:00:00Z`,
    })),
  )
  server.get('/api/v4/projects/:id/repository/commits/:sha/refs', async (request) => {
    // v0.9 n'est que sur la branche « legacy ».
    const sha = (request.params as { sha: string }).sha
    return sha.startsWith('v0.9') ? [{ name: 'legacy' }] : [{ name: 'main' }, { name: 'develop' }]
  })
  server.get('/api/v4/projects/:id/registry/repositories', async () => [
    { location: 'registry.gitlab.example.com/acme/site/front' },
    { location: 'registry.gitlab.example.com/acme/site/back' },
  ])
  server.get('/api/v4/personal_access_tokens/self', async () => ({
    name: 'vercio',
    scopes,
    expires_at: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
  }))
  // Webhooks de projet : création réservée à un token de portée « api ».
  const hooks = new Map<string, { id: number; url: string; token: string; project: string }>()
  let nextHook = 1
  const canWrite = () => scopes.includes('api')
  server.post('/api/v4/projects/:id/hooks', async (request, reply) => {
    if (!canWrite()) return reply.code(403).send({ message: '403 Forbidden' })
    const body = request.body as { url: string; token: string }
    const hook = {
      id: nextHook++,
      url: body.url,
      token: body.token,
      project: (request.params as { id: string }).id,
    }
    hooks.set(String(hook.id), hook)
    return reply.code(201).send(hook)
  })
  server.put('/api/v4/projects/:id/hooks/:hook', async (request, reply) => {
    if (!canWrite()) return reply.code(403).send({ message: '403 Forbidden' })
    const hook = hooks.get((request.params as { hook: string }).hook)
    if (!hook) return reply.code(404).send({ message: '404 Not found' })
    Object.assign(hook, request.body as object)
    return hook
  })
  server.delete('/api/v4/projects/:id/hooks/:hook', async (request, reply) => {
    if (!hooks.delete((request.params as { hook: string }).hook)) return reply.code(404).send({})
    return reply.code(204).send()
  })
  const url = await listen(server)
  return { url, hooks, close: () => server.close() }
}

export const REGISTRY_USER = 'vercio-bot'
export const REGISTRY_PASSWORD = 'registry-test-password'

/**
 * Registry v2 avec authentification par jeton (comme GitLab, Harbor ou Docker Hub) :
 * /v2/ répond 401 + challenge Bearer, le service /jwt/auth délivre un jeton en Basic.
 */
export async function startFakeRegistry(mode: 'bearer' | 'basic' | 'anonymous' = 'bearer') {
  const server = Fastify()
  let base = ''
  const basic = `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`).toString('base64')}`

  server.get('/v2/', async (request, reply) => {
    reply.header('Docker-Distribution-API-Version', 'registry/2.0')
    const auth = request.headers.authorization
    if (mode === 'anonymous') return {}
    if (mode === 'basic') {
      if (auth === basic) return {}
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="Registry"').send({})
    }
    if (auth === 'Bearer jeton-valide') return {}
    return reply
      .code(401)
      .header('WWW-Authenticate', `Bearer realm="${base}/jwt/auth",service="container_registry"`)
      .send({})
  })
  server.get('/jwt/auth', async (request, reply) => {
    const query = request.query as Record<string, string>
    if (query.service !== 'container_registry') return reply.code(400).send({})
    if (request.headers.authorization !== basic) return reply.code(401).send({})
    return { token: 'jeton-valide' }
  })
  base = await listen(server)
  return { url: base, close: () => server.close() }
}

export const GITHUB_CLASSIC_TOKEN = 'ghp_testClassicToken0000000000000000abcd'
export const GITHUB_FINE_TOKEN = 'github_pat_testFineGrained000000000000wxyz'

/**
 * API REST GitHub minimale, servie sous /api/v3 comme GitHub Enterprise Server.
 * Les en-têtes reproduisent ceux de GitHub (portées, expiration, quota).
 */
export async function startFakeGitHub(options: { scopes?: string; enterprise?: boolean } = {}) {
  const server = Fastify()
  server.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization
    if (auth !== `Bearer ${GITHUB_CLASSIC_TOKEN}` && auth !== `Bearer ${GITHUB_FINE_TOKEN}`) {
      return reply.code(401).send({ message: 'Bad credentials' })
    }
    reply.header('x-ratelimit-limit', '5000').header('x-ratelimit-remaining', '4990')
    if (auth === `Bearer ${GITHUB_CLASSIC_TOKEN}`) {
      reply.header('x-oauth-scopes', options.scopes ?? 'repo, read:packages')
      reply.header('github-authentication-token-expiration', '2030-01-01 00:00:00 UTC')
    }
  })
  server.get('/api/v3/user', async () => ({ login: 'vercio-bot', type: 'User' }))
  server.get('/api/v3/user/repos', async () => [
    {
      full_name: 'Acme/blog',
      name: 'blog',
      default_branch: 'main',
      html_url: 'https://github.example.com/Acme/blog',
      private: true,
    },
  ])
  server.get('/api/v3/repos/Acme/blog', async () => ({ default_branch: 'main' }))
  server.get('/api/v3/repos/Acme/blog/branches', async () => [{ name: 'main' }, { name: 'next' }])
  server.get('/api/v3/repos/Acme/blog/git/trees/:ref', async () => ({
    truncated: false,
    tree: [
      { path: 'infra/stack.yaml', type: 'blob' },
      { path: '.github/workflows/build.yml', type: 'blob' },
      { path: 'infra', type: 'tree' },
    ],
  }))
  server.get('/api/v3/repos/Acme/blog/contents/*', async (request, reply) => {
    if ((request.params as { '*': string })['*'] !== 'deploy/compose.yml') {
      return reply.code(404).send({ message: 'Not Found' })
    }
    if (!String(request.headers.accept).includes('raw')) return reply.code(400).send({})
    reply.type('text/plain')
    return 'services:\n  web:\n    image: ghcr.io/acme/blog:latest\n'
  })
  server.get('/api/v3/orgs/Acme/packages', async () => [
    { name: 'blog', repository: { full_name: 'Acme/blog' } },
    { name: 'autre', repository: { full_name: 'Acme/autre' } },
  ])
  server.get('/api/v3/meta', async () =>
    options.enterprise
      ? { installed_version: '3.17.2' }
      : { verifiable_password_authentication: true },
  )
  // Webhooks de dépôt : réservés au token classique avec admin:repo_hook (404 sinon, comme GitHub).
  const hooks = new Map<
    string,
    { id: number; events: string[]; config: { url: string; secret: string } }
  >()
  let nextHook = 1
  const canWrite = (request: { headers: Record<string, unknown> }) =>
    request.headers.authorization === `Bearer ${GITHUB_CLASSIC_TOKEN}` &&
    (options.scopes ?? '').includes('admin:repo_hook')
  server.post('/api/v3/repos/Acme/blog/hooks', async (request, reply) => {
    if (!canWrite(request)) return reply.code(404).send({ message: 'Not Found' })
    const body = request.body as { events: string[]; config: { url: string; secret: string } }
    const hook = { id: nextHook++, events: body.events, config: body.config }
    hooks.set(String(hook.id), hook)
    return reply.code(201).send(hook)
  })
  server.patch('/api/v3/repos/Acme/blog/hooks/:hook', async (request, reply) => {
    const hook = hooks.get((request.params as { hook: string }).hook)
    if (!canWrite(request) || !hook) return reply.code(404).send({ message: 'Not Found' })
    Object.assign(hook, request.body as object)
    return hook
  })
  const url = await listen(server)
  return { url, hooks, close: () => server.close() }
}

/**
 * Registry servant de vrais manifestes : authentification par jeton avec portée,
 * index multi-architecture, et blobs redirigés vers un stockage externe (comme S3).
 * `images` : { 'acme/site/front:v1.0': '2026-03-01T10:00:00Z' } (date de création).
 */
export async function startFakeImageRegistry(images: Record<string, string>) {
  const server = Fastify()
  let base = ''
  const scopes: string[] = []
  server.get('/v2/', async (_request, reply) =>
    reply
      .code(401)
      .header('WWW-Authenticate', `Bearer realm="${base}/token",service="registry"`)
      .send({}),
  )
  server.get('/token', async (request) => {
    scopes.push((request.query as { scope?: string }).scope ?? '')
    return { token: 'jeton' }
  })
  server.get('/v2/*', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer jeton') return reply.code(401).send({})
    const rest = (request.params as { '*': string })['*']
    const tagList = /^(.+)\/tags\/list$/.exec(rest)
    if (tagList) {
      const prefix = `${tagList[1]}:`
      const tags = Object.keys(images)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
      if (!tags.length) return reply.code(404).send({ errors: [{ code: 'NAME_UNKNOWN' }] })
      return { name: tagList[1], tags }
    }
    const manifest = /^(.+)\/manifests\/([^/]+)$/.exec(rest)
    if (manifest) {
      const [, path, ref] = manifest
      if (ref!.startsWith('sha256:child-')) {
        return { schemaVersion: 2, config: { digest: ref!.replace('child-', 'cfg-') } }
      }
      const created = images[`${path}:${ref}`]
      if (!created) return reply.code(404).send({ errors: [{ code: 'MANIFEST_UNKNOWN' }] })
      // Le digest change quand l'image est reconstruite (nouvelle date de création).
      const id = Buffer.from(`${path}:${ref}|${created}`).toString('hex')
      reply.header('Docker-Content-Digest', `sha256:${id}`)
      // Les images « multi » sont servies comme un index multi-architecture.
      if (path!.endsWith('multi')) {
        return {
          schemaVersion: 2,
          manifests: [
            { digest: `sha256:child-arm-${id}`, platform: { os: 'linux', architecture: 'arm64' } },
            { digest: `sha256:child-${id}`, platform: { os: 'linux', architecture: 'amd64' } },
          ],
        }
      }
      return { schemaVersion: 2, config: { digest: `sha256:cfg-${id}` } }
    }
    const blob = /^(.+)\/blobs\/sha256:cfg-(.+)$/.exec(rest)
    if (blob) return reply.redirect(`${base}/storage/${blob[2]}?signature=abc`, 307)
    return reply.code(404).send({})
  })
  server.get('/storage/:id', async (request, reply) => {
    if (request.headers.authorization) return reply.code(400).send({ error: 'auth inattendue' })
    const key = Buffer.from((request.params as { id: string }).id, 'hex')
      .toString()
      .split('|')[0]!
    return { created: images[key] ?? null, architecture: 'amd64' }
  })
  base = await listen(server)
  return { url: base, scopes, close: () => server.close() }
}
