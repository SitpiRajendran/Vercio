import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql as rawSql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { CreateProjectInput, ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { Database } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import {
  GITHUB_CLASSIC_TOKEN,
  GITLAB_TOKEN,
  startFakeGitHub,
  startFakeGitLab,
} from './fake-services.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('API — projets', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  let github: Awaited<ReturnType<typeof startFakeGitHub>>
  const cookies: Record<string, string> = {}
  let gitlabId: string
  let githubId: string
  let registryId: string

  async function sessionFor(username: string, roles: string[]) {
    const [user] = await db
      .insert(users)
      .values({ provider: 'oidc', subject: username, username, displayName: username, roles })
      .returning()
    const { token } = await new SessionStore(db, 3_600_000).create(user!.id, {})
    return `__Host-vercio_session=${token}`
  }

  function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    as: 'admin' | 'deployer' | 'viewer' = 'admin',
  ) {
    return app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[as]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })
  }

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
    cookies.admin = await sessionFor('admin', ['vercio-admin'])
    cookies.deployer = await sessionFor('deployer', ['vercio-deployer'])
    cookies.viewer = await sessionFor('viewer', ['vercio-viewer'])
    gitlab = await startFakeGitLab()
    github = await startFakeGitHub()
    gitlabId = (
      await call('POST', '/settings/git-providers', {
        name: 'GitLab',
        type: 'gitlab',
        url: gitlab.url,
        token: GITLAB_TOKEN,
      })
    ).json().id
    githubId = (
      await call('POST', '/settings/git-providers', {
        name: 'GitHub',
        type: 'github',
        url: github.url,
        token: GITHUB_CLASSIC_TOKEN,
      })
    ).json().id
    registryId = (
      await call('POST', '/settings/registries', {
        name: 'Registry GitLab',
        type: 'gitlab',
        url: 'registry.gitlab.example.com',
        gitProviderId: gitlabId,
      })
    ).json().id
  })

  afterAll(async () => {
    await gitlab?.close()
    await github?.close()
    await close?.()
  })

  describe('catalogue', () => {
    it('cherche des dépôts, branches et images GitLab', async () => {
      const repos = await call('GET', `/catalog/git-providers/${gitlabId}/repositories?q=site`)
      expect(repos.json()).toEqual([
        expect.objectContaining({ fullName: 'acme/site', defaultBranch: 'main', private: true }),
      ])
      const branches = await call(
        'GET',
        `/catalog/git-providers/${gitlabId}/branches?repository=acme/site`,
      )
      expect(branches.json()).toEqual([
        { name: 'main', isDefault: true },
        { name: 'develop', isDefault: false },
      ])
      const images = await call(
        'GET',
        `/catalog/git-providers/${gitlabId}/images?repository=acme/site`,
      )
      expect(images.json()).toContainEqual({
        host: 'registry.gitlab.example.com',
        path: 'acme/site/front',
      })
    })

    it('lit et analyse un fichier Compose GitLab', async () => {
      const response = await call('POST', `/catalog/git-providers/${gitlabId}/compose`, {
        repository: 'acme/site',
        ref: 'main',
        path: 'docker-compose.yml',
      })
      expect(response.json().analysis.services.map((s: { name: string }) => s.name)).toEqual([
        'front',
        'back',
        'redis',
      ])
      const missing = await call('POST', `/catalog/git-providers/${gitlabId}/compose`, {
        repository: 'acme/site',
        ref: 'develop',
        path: 'docker-compose.yml',
      })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().error).toContain('introuvable sur la branche develop')
    })

    it('liste les fichiers Compose possibles du dépôt (GitLab paginé, GitHub)', async () => {
      const gitlabFiles = await call(
        'GET',
        `/catalog/git-providers/${gitlabId}/compose-files?repository=acme/site&ref=main`,
      )
      expect(gitlabFiles.json()).toEqual({
        files: ['docker-compose.yml', 'deploy/compose.prod.yml'],
        detected: 'docker-compose.yml',
      })
      const githubFiles = await call(
        'GET',
        `/catalog/git-providers/${githubId}/compose-files?repository=Acme/blog&ref=main`,
      )
      expect(githubFiles.json()).toEqual({ files: ['infra/stack.yaml'], detected: null })
    })

    it('fait de même avec GitHub et GHCR', async () => {
      const repos = await call('GET', `/catalog/git-providers/${githubId}/repositories?q=blog`)
      expect(repos.json()[0]).toMatchObject({ fullName: 'Acme/blog' })
      const branches = await call(
        'GET',
        `/catalog/git-providers/${githubId}/branches?repository=Acme/blog`,
      )
      expect(branches.json()).toEqual([
        { name: 'main', isDefault: true },
        { name: 'next', isDefault: false },
      ])
      const file = await call('POST', `/catalog/git-providers/${githubId}/compose`, {
        repository: 'Acme/blog',
        ref: 'main',
        path: 'deploy/compose.yml',
      })
      expect(file.json().analysis.services[0]).toMatchObject({
        name: 'web',
        image: 'ghcr.io/acme/blog:latest',
      })
      const images = await call(
        'GET',
        `/catalog/git-providers/${githubId}/images?repository=Acme/blog`,
      )
      expect(images.json()).toEqual([{ host: 'ghcr.io', path: 'acme/blog' }])
    })

    it('réserve la lecture des dépôts aux administrateurs', async () => {
      // Un déployeur ne parcourt pas tout ce que voit le token Git.
      const base = `/catalog/git-providers/${gitlabId}`
      expect((await call('GET', `${base}/repositories?q=`, undefined, 'deployer')).statusCode).toBe(
        403,
      )
      expect(
        (
          await call(
            'POST',
            `${base}/compose`,
            { repository: 'acme/site', ref: 'main', path: '.env.production' },
            'deployer',
          )
        ).statusCode,
      ).toBe(403)
      expect(
        (await call('GET', `${base}/branches?repository=infra/secrets`, undefined, 'deployer'))
          .statusCode,
      ).toBe(403)
    })

    it('n’expose aucun secret et refuse les lecteurs', async () => {
      const providers = await call('GET', '/catalog/git-providers', undefined, 'deployer')
      expect(JSON.stringify(providers.json())).not.toContain(GITLAB_TOKEN)
      expect((await call('GET', '/catalog/git-providers', undefined, 'viewer')).statusCode).toBe(
        403,
      )
    })
  })

  const siteProject = (): CreateProjectInput => ({
    name: 'Site vitrine',
    slug: 'site',
    type: 'compose',
    compose: { source: 'git', sourceKey: 'src', path: 'docker-compose.yml' },
    sources: [
      {
        key: 'src',
        name: 'site',
        gitProviderId: gitlabId,
        repository: 'acme/site',
        defaultBranch: 'main',
      },
    ],
    trackedServices: [
      { serviceName: 'front', sourceKey: 'src', registryId, imageRepository: 'acme/site/front' },
      { serviceName: 'back', sourceKey: 'src', registryId, imageRepository: 'acme/site/back' },
    ],
    environments: [
      { name: 'Production', slug: 'prod', sources: [{ source: 'src', branch: 'main' }] },
      {
        name: 'Staging',
        slug: 'staging',
        sources: [{ source: 'src', branch: 'develop', ref: 'latest', mode: 'tracking' }],
      },
    ],
  })

  let project: ProjectView

  it('crée un projet depuis un dépôt GitLab', async () => {
    const response = await call('POST', '/projects', siteProject())
    expect(response.statusCode).toBe(201)
    project = response.json()
    expect(project.compose).toMatchObject({ source: 'git', path: 'docker-compose.yml' })
    expect(project.trackedServices).toEqual([
      expect.objectContaining({
        serviceName: 'back',
        image: 'registry.gitlab.example.com/acme/site/back',
      }),
      expect.objectContaining({
        serviceName: 'front',
        image: 'registry.gitlab.example.com/acme/site/front',
      }),
    ])
    expect(project.environments.map((env) => env.composeProject)).toEqual([
      'vercio_site_prod',
      'vercio_site_staging',
    ])
    expect(project.environments[1]!.sources[0]).toMatchObject({
      branch: 'develop',
      ref: 'latest',
      mode: 'tracking',
    })
  })

  it('refuse les incohérences', async () => {
    const duplicate = await call('POST', '/projects', siteProject())
    expect(duplicate.statusCode).toBe(409)

    const badService = siteProject()
    badService.slug = 'site-2'
    badService.trackedServices[0]!.serviceName = 'inexistant'
    expect((await call('POST', '/projects', badService)).json()).toMatchObject({
      field: 'trackedServices',
    })

    const badFile = siteProject()
    badFile.slug = 'site-3'
    badFile.compose = { source: 'git', sourceKey: 'src', path: 'absent.yml' }
    expect((await call('POST', '/projects', badFile)).json().error).toContain(
      'Lecture du fichier Compose impossible',
    )

    const missingBranch = siteProject()
    missingBranch.slug = 'site-4'
    missingBranch.environments[0]!.sources = []
    expect((await call('POST', '/projects', missingBranch)).json()).toMatchObject({
      field: 'sources',
    })

    const badSlug = siteProject()
    badSlug.slug = 'Site Vitrine'
    expect((await call('POST', '/projects', badSlug)).json()).toMatchObject({ field: 'slug' })
  })

  it('crée un projet de service seul avec un Compose saisi', async () => {
    const response = await call('POST', '/projects', {
      name: 'PostgreSQL mutualisé',
      slug: 'postgres',
      type: 'single',
      compose: { source: 'inline', content: 'services:\n  postgres:\n    image: postgres:17\n' },
      sources: [],
      trackedServices: [],
      environments: [{ name: 'Production', slug: 'prod', sources: [] }],
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().compose).toEqual({
      source: 'inline',
      content: 'services:\n  postgres:\n    image: postgres:17\n',
    })
  })

  it('liste et lit les projets en lecture seule', async () => {
    const list = await call('GET', '/projects', undefined, 'viewer')
    expect(list.json().map((p: { slug: string }) => p.slug)).toEqual(['postgres', 'site'])
    expect(list.json()[1]).toMatchObject({
      sources: [{ repository: 'acme/site', gitProviderType: 'gitlab' }],
      environments: [
        { slug: 'prod', refs: ['latest'], locked: false },
        { slug: 'staging', refs: ['latest'], locked: false },
      ],
    })
    expect((await call('GET', '/projects/site', undefined, 'viewer')).json().id).toBe(project.id)
    expect((await call('GET', '/projects/inconnu', undefined, 'viewer')).statusCode).toBe(404)
  })

  it('réserve la création et la suppression aux administrateurs', async () => {
    expect((await call('POST', '/projects', siteProject(), 'deployer')).statusCode).toBe(403)
    expect(
      (await call('DELETE', `/projects/${project.id}`, undefined, 'deployer')).statusCode,
    ).toBe(403)
  })

  it('verrouille un environnement sur un tag (deployer)', async () => {
    const prod = project.environments[0]!
    const source = project.sources[0]!
    const response = await call(
      'PUT',
      `/projects/${project.id}/environments/${prod.id}`,
      {
        name: 'Production',
        sources: [{ source: source.id, branch: 'main', ref: 'v1.3.0', mode: 'locked' }],
      },
      'deployer',
    )
    expect(response.statusCode).toBe(200)
    expect(response.json().environments[0].sources[0]).toMatchObject({
      ref: 'v1.3.0',
      mode: 'locked',
    })
    const list = await call('GET', '/projects', undefined, 'viewer')
    expect(list.json()[1].environments[0]).toMatchObject({ refs: ['v1.3.0'], locked: true })
  })

  it('réserve aux administrateurs le changement de branche du fichier Compose', async () => {
    const prod = project.environments[0]!
    const source = project.sources[0]!
    const response = await call(
      'PUT',
      `/projects/${project.id}/environments/${prod.id}`,
      {
        name: 'Production',
        sources: [{ source: source.id, branch: 'piege', ref: 'v1.3.0', mode: 'locked' }],
      },
      'deployer',
    )
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toContain('administrateur')
  })

  it('règle la politique de redémarrage de l’environnement', async () => {
    const prod = project.environments[0]!
    expect(prod.restartPolicy).toBe('unless-stopped')
    const sources = [
      { source: project.sources[0]!.id, branch: 'main', ref: 'v1.3.0', mode: 'locked' },
    ]
    const url = `/projects/${project.id}/environments/${prod.id}`
    const updated = await call('PUT', url, { name: 'Production', sources, restartPolicy: 'always' })
    expect(updated.json().environments[0].restartPolicy).toBe('always')
    // Champ absent : inchangé.
    const kept = await call('PUT', url, { name: 'Production', sources })
    expect(kept.json().environments[0].restartPolicy).toBe('always')
    const invalid = await call('PUT', url, {
      name: 'Production',
      sources,
      restartPolicy: 'parfois',
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('ajoute une source GitHub et l’ajoute aux environnements existants', async () => {
    const current = project
    const response = await call('PUT', `/projects/${project.id}`, {
      name: 'Site vitrine',
      slug: 'site',
      type: 'compose',
      compose: { source: 'git', sourceKey: current.sources[0]!.id, path: 'docker-compose.yml' },
      sources: [
        {
          key: current.sources[0]!.id,
          name: 'site',
          gitProviderId: gitlabId,
          repository: 'acme/site',
          defaultBranch: 'main',
        },
        {
          key: 'blog',
          name: 'blog',
          gitProviderId: githubId,
          repository: 'Acme/blog',
          defaultBranch: 'main',
        },
      ],
      trackedServices: [
        {
          serviceName: 'front',
          sourceKey: current.sources[0]!.id,
          registryId,
          imageRepository: 'acme/site/front',
        },
      ],
    })
    expect(response.statusCode).toBe(200)
    const updated: ProjectView = response.json()
    expect(updated.sources.map((source) => source.repository)).toEqual(['acme/site', 'Acme/blog'])
    expect(updated.trackedServices).toHaveLength(1)
    for (const env of updated.environments) expect(env.sources).toHaveLength(2)
    // L'identifiant du projet ne change pas.
    const renamed = await call('PUT', `/projects/${project.id}`, {
      ...siteProject(),
      slug: 'autre',
    })
    expect(renamed.json()).toMatchObject({ field: 'slug' })
    project = updated
  })

  it('chiffre les variables et ne renvoie jamais les secrets', async () => {
    const prod = project.environments[0]!
    const url = `/projects/${project.id}/variables?environment=${prod.id}`
    expect(
      (
        await call(
          'PUT',
          url,
          {
            variables: [
              { key: 'NODE_ENV', value: 'production', secret: false },
              { key: 'DB_PASSWORD', value: 'tres-secret', secret: true },
            ],
          },
          'deployer',
        )
      ).statusCode,
    ).toBe(204)
    expect((await call('GET', url, undefined, 'viewer')).json()).toEqual([
      { key: 'DB_PASSWORD', value: null, secret: true },
      { key: 'NODE_ENV', value: 'production', secret: false },
    ])
    const stored = await db.execute<{ key: string; value_enc: string }>(
      rawSql`select key, value_enc from env_variables`,
    )
    expect(JSON.stringify(stored)).not.toContain('tres-secret')

    // Un secret laissé vide (null) garde sa valeur ; une variable absente est supprimée.
    await call(
      'PUT',
      url,
      { variables: [{ key: 'DB_PASSWORD', value: null, secret: true }] },
      'deployer',
    )
    const after = await db.execute<{ key: string; value_enc: string }>(
      rawSql`select key, value_enc from env_variables`,
    )
    expect(after.map((row) => row.key)).toEqual(['DB_PASSWORD'])
    expect(after[0]!.value_enc).toBe(stored.find((row) => row.key === 'DB_PASSWORD')!.value_enc)
    // Décocher « secret » sans ressaisir la valeur ne la révèle pas.
    await call(
      'PUT',
      url,
      { variables: [{ key: 'DB_PASSWORD', value: null, secret: false }] },
      'deployer',
    )
    expect((await call('GET', url, undefined, 'viewer')).json()).toEqual([
      { key: 'DB_PASSWORD', value: null, secret: true },
    ])

    const missing = await call('PUT', url, {
      variables: [{ key: 'NOUVEAU', value: null, secret: true }],
    })
    expect(missing.statusCode).toBe(400)
    const invalid = await call('PUT', url, {
      variables: [{ key: '1BAD', value: 'x', secret: false }],
    })
    expect(invalid.statusCode).toBe(400)
    // Les variables partagées par le projet sont distinctes de celles de l'environnement.
    expect((await call('GET', `/projects/${project.id}/variables`)).json()).toEqual([])
  })

  it('supprime un environnement puis le projet', async () => {
    const staging = project.environments[1]!
    expect(
      (await call('DELETE', `/projects/${project.id}/environments/${staging.id}`)).statusCode,
    ).toBe(204)
    expect((await call('DELETE', `/projects/${project.id}`)).statusCode).toBe(204)
    expect((await call('GET', '/projects/site')).statusCode).toBe(404)
    const leftovers = await db.execute<{ count: string }>(
      rawSql`select count(*) from env_variables`,
    )
    expect(Number(leftovers[0]!.count)).toBe(0)
    // Le fournisseur et le registry redeviennent supprimables.
    expect((await call('GET', '/settings/git-providers')).json()[1]).toMatchObject({ usedBy: 0 })
  })
})
