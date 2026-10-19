import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ProjectView, VersionChoices } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { Database } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { GITLAB_TOKEN, startFakeGitLab, startFakeImageRegistry } from './fake-services.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('API — versions disponibles', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  let registry: Awaited<ReturnType<typeof startFakeImageRegistry>>
  let cookie: string
  let project: ProjectView

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
    const [user] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'a',
        username: 'a',
        displayName: 'a',
        roles: ['vercio-admin'],
      })
      .returning()
    cookie = `__Host-vercio_session=${(await new SessionStore(db, 3_600_000).create(user!.id, {})).token}`

    gitlab = await startFakeGitLab()
    const img = (tag: string, date: string) => ({
      [`acme/site/front:${tag}`]: date,
      [`acme/site/back:${tag}`]: date,
    })
    registry = await startFakeImageRegistry({
      ...img('latest', '2026-02-21T08:00:00Z'),
      ...img('v1.3', '2026-02-18T10:05:00Z'),
      ...img('v1.2', '2026-02-17T10:05:00Z'),
      ...img('v1.1', '2026-02-16T10:05:00Z'),
      ...img('v1.0', '2026-02-15T10:05:00Z'),
      ...img('v0.9', '2026-02-14T10:05:00Z'),
      // v1.4 : seul le front est construit (pipeline en cours).
      'acme/site/front:v1.4': '2026-02-19T10:05:00Z',
      'acme/site/back:develop-latest': '2026-02-20T09:00:00Z',
      'acme/site/front:develop-latest': '2026-02-20T09:00:00Z',
      // Convention « prod » : tag {branch} pour le dernier build, une image par commit.
      ...img('prod', '2026-03-03T11:00:00Z'),
      ...img('aaaaaaaa', '2026-03-03T11:00:00Z'),
      ...img('bbbbbbbb', '2026-03-01T11:00:00Z'),
    })

    const provider = (
      await call('POST', '/settings/git-providers', {
        name: 'GitLab',
        type: 'gitlab',
        url: gitlab.url,
        token: GITLAB_TOKEN,
      })
    ).json()
    const reg = (
      await call('POST', '/settings/registries', {
        name: 'Registry',
        type: 'oci',
        url: registry.url,
        username: 'ci',
        password: 'secret',
      })
    ).json()
    project = (
      await call('POST', '/projects', {
        name: 'Site',
        slug: 'site',
        type: 'compose',
        compose: { source: 'git', sourceKey: 's', path: 'docker-compose.yml' },
        sources: [
          {
            key: 's',
            name: 'site',
            gitProviderId: provider.id,
            repository: 'acme/site',
            defaultBranch: 'main',
          },
        ],
        trackedServices: [
          {
            serviceName: 'front',
            sourceKey: 's',
            registryId: reg.id,
            imageRepository: 'acme/site/front',
          },
          {
            serviceName: 'back',
            sourceKey: 's',
            registryId: reg.id,
            imageRepository: 'acme/site/back',
          },
        ],
        environments: [{ name: 'Prod', slug: 'prod', sources: [{ source: 's', branch: 'main' }] }],
      })
    ).json()
  })

  afterAll(async () => {
    await gitlab?.close()
    await registry?.close()
    await close?.()
  })

  it('propose latest et les 5 derniers tags complets de la branche', async () => {
    const source = project.sources[0]!.id
    const response = await call(
      'GET',
      `/projects/${project.id}/versions?source=${source}&branch=main`,
    )
    expect(response.statusCode).toBe(200)
    const versions: VersionChoices = response.json()
    expect(versions.latest).toMatchObject({
      tag: 'latest',
      available: true,
      pushedAt: '2026-02-21T08:00:00Z',
    })
    expect(versions.tags.map((tag) => [tag.name, tag.complete])).toEqual([
      ['v1.4', false],
      ['v1.3', true],
      ['v1.2', true],
      ['v1.1', true],
      ['v1.0', true],
    ])
    // v0.9 (autre branche) et « experimental » (hors format) sont exclus ;
    // il n'y a que 4 tags complets sur main.
    expect(versions.tags[0]!.missing).toEqual(['back'])
    expect(versions.tags[1]).toMatchObject({
      pushedAt: '2026-02-18T10:05:00Z',
      commit: { shortSha: 'v1.3-sha', message: 'Version v1.3', author: 'Alice' },
      pipelineUrl: `${gitlab.url}/acme/site/-/pipelines?ref=v1.3`,
    })
    expect(versions.tags[1]!.images[0]!.digest).toMatch(/^sha256:/)
    // Le jeton est demandé avec la portée de chaque image.
    expect(registry.scopes).toContain('repository:acme/site/front:pull')
  })

  it('utilise le canal <branche>-latest hors branche par défaut', async () => {
    const source = project.sources[0]!.id
    const versions: VersionChoices = (
      await call('GET', `/projects/${project.id}/versions?source=${source}&branch=develop`)
    ).json()
    expect(versions.latest).toMatchObject({ tag: 'develop-latest', available: true })
  })

  it('explique pourquoi le dernier build est absent', async () => {
    const source = project.sources[0]!.id
    const versions: VersionChoices = (
      await call('GET', `/projects/${project.id}/versions?source=${source}&branch=feature`)
    ).json()
    expect(versions.latest).toMatchObject({ tag: 'feature-latest', available: false })
    expect(versions.warnings.join('\n')).toContain(
      'Le tag « feature-latest » n’existe pas ; tags présents :',
    )
  })

  it('suit une convention de tags personnalisée : {branch} et images par commit', async () => {
    const view = (await call('GET', `/projects/${project.slug}`)).json()
    const source = view.sources[0]
    const body = {
      name: view.name,
      slug: view.slug,
      type: view.type,
      compose: { source: 'git', sourceKey: source.id, path: view.compose.path },
      sources: [
        {
          key: source.id,
          name: source.name,
          gitProviderId: source.gitProviderId,
          repository: source.repository,
          defaultBranch: source.defaultBranch,
          latestTagTemplate: '{branch}',
          versionSource: 'commits',
          commitTagTemplate: '{sha:8}',
        },
      ],
      trackedServices: view.trackedServices.map(
        (service: { serviceName: string; registryId: string; imageRepository: string }) => ({
          serviceName: service.serviceName,
          sourceKey: source.id,
          registryId: service.registryId,
          imageRepository: service.imageRepository,
        }),
      ),
    }
    const update = await call('PUT', `/projects/${project.id}`, body)
    expect(update.statusCode).toBe(200)
    expect(update.json().sources[0].tagConvention).toEqual({
      latestTagTemplate: '{branch}',
      versionSource: 'commits',
      tagPattern: '^v\\d+\\.\\d+(\\.\\d+)?$',
      commitTagTemplate: '{sha:8}',
    })

    const versions: VersionChoices = (
      await call('GET', `/projects/${project.id}/versions?source=${source.id}&branch=prod`)
    ).json()
    expect(versions.versionSource).toBe('commits')
    expect(versions.latest).toMatchObject({ tag: 'prod', available: true })
    // Le commit cccc… n'a pas d'image : il n'est pas proposé.
    expect(versions.tags.map((tag) => tag.name)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(versions.tags[0]!.commit).toMatchObject({ message: 'Commit aaaaaaaa', author: 'Bob' })

    const invalid = await call('PUT', `/projects/${project.id}`, {
      ...body,
      sources: [{ ...body.sources[0], commitTagTemplate: 'sans-sha' }],
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toContain('{sha}')
  })

  it('valide les paramètres', async () => {
    const missing = await call(
      'GET',
      `/projects/${project.id}/versions?source=${project.id}&branch=main`,
    )
    expect(missing.statusCode).toBe(404)
    const bad = await call('GET', `/projects/${project.id}/versions?branch=main`)
    expect(bad.statusCode).toBe(400)
  })
})

describe('OciRegistryClient.getTag', async () => {
  const { OciRegistryClient } = await import('../src/providers/registry.js')
  it('lit un index multi-architecture (variante linux/amd64)', async () => {
    const registry = await startFakeImageRegistry({ 'acme/multi:v1': '2026-05-05T05:05:05Z' })
    const client = new OciRegistryClient({ url: registry.url, username: 'u', password: 'p' })
    const info = await client.getTag('acme/multi', 'v1')
    const absent = await client.getTag('acme/multi', 'v2')
    await registry.close()
    expect(info).toMatchObject({ createdAt: '2026-05-05T05:05:05Z' })
    expect(absent).toBeNull()
  })
})
