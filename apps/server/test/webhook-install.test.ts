import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectView, WebhookConfigView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { users } from '../src/db/schema.js'
import { GITLAB_TOKEN, startFakeGitLab } from './fake-services.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('Création du webhook chez GitLab', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  let writer: Awaited<ReturnType<typeof startFakeGitLab>>
  let reader: Awaited<ReturnType<typeof startFakeGitLab>>
  const cookies: Record<string, string> = {}

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, role = 'admin') =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  async function createProject(slug: string, gitlabUrl: string): Promise<ProjectView> {
    const provider = (
      await call('POST', '/settings/git-providers', {
        name: `GitLab ${slug}`,
        type: 'gitlab',
        url: gitlabUrl,
        token: GITLAB_TOKEN,
      })
    ).json()
    const response = await call('POST', '/projects', {
      name: slug,
      slug,
      type: 'compose',
      compose: { source: 'inline', content: 'services:\n  web:\n    image: nginx\n' },
      sources: [
        {
          key: 's',
          name: 'site',
          gitProviderId: provider.id,
          repository: 'acme/site',
          defaultBranch: 'main',
        },
      ],
      trackedServices: [],
      environments: [
        { name: 'Production', slug: 'prod', sources: [{ source: 's', branch: 'main' }] },
        { name: 'Recette', slug: 'recette', sources: [{ source: 's', branch: 'develop' }] },
      ],
    })
    expect(response.statusCode).toBe(201)
    return response.json()
  }

  beforeAll(async () => {
    ctx = await setupTestApp()
    for (const [role, roles] of [
      ['admin', ['vercio-admin']],
      ['deployer', ['vercio-deployer']],
    ] as const) {
      const [user] = await ctx.db
        .insert(users)
        .values({
          provider: 'oidc',
          subject: role,
          username: role,
          displayName: role,
          roles: [...roles],
        })
        .returning()
      cookies[role] =
        `__Host-vercio_session=${(await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})).token}`
    }
    writer = await startFakeGitLab(['api', 'read_registry'])
    reader = await startFakeGitLab()
  })

  afterAll(async () => {
    await writer?.close()
    await reader?.close()
    await ctx?.close()
  })

  it('crée le webhook natif, le met à jour à la régénération, le supprime avec l’environnement', async () => {
    const project = await createProject('site', writer.url)
    const [prod, recette] = project.environments
    const source = project.sources[0]!
    const base = `/projects/${project.id}/environments/${prod!.id}/webhooks`

    const before = (await call('GET', base)).json() as WebhookConfigView
    expect(before.sources[0]).toMatchObject({ provider: 'gitlab', installedAt: null })
    expect(before.sources[0]!.providerHooksUrl).toBe(`${writer.url}/acme/site/-/hooks`)

    expect(
      (await call('POST', `${base}/${source.id}/install`, undefined, 'deployer')).statusCode,
    ).toBe(403)
    const installed = await call('POST', `${base}/${source.id}/install`)
    expect(installed.statusCode).toBe(200)
    const view = installed.json() as WebhookConfigView
    expect(view.sources[0]!.installedAt).not.toBeNull()
    expect([...writer.hooks.values()]).toEqual([
      expect.objectContaining({
        project: 'acme/site',
        url: view.sources[0]!.urls!.gitlab,
        token: view.sources[0]!.secret,
      }),
    ])

    // Réinstaller met à jour le même webhook, sans doublon.
    await call('POST', `${base}/${source.id}/install`)
    expect(writer.hooks.size).toBe(1)

    // Nouvelle URL : le webhook distant suit.
    const regenerated = (
      await call('POST', `${base}/${source.id}/regenerate`)
    ).json() as WebhookConfigView
    expect([...writer.hooks.values()][0]).toMatchObject({
      url: regenerated.sources[0]!.urls!.gitlab,
      token: regenerated.sources[0]!.secret,
    })

    // Un second environnement a son propre webhook.
    await call(
      'POST',
      `/projects/${project.id}/environments/${recette!.id}/webhooks/${source.id}/install`,
    )
    expect(writer.hooks.size).toBe(2)
    expect(
      (await call('DELETE', `/projects/${project.id}/environments/${recette!.id}`)).statusCode,
    ).toBe(204)
    expect(writer.hooks.size).toBe(1)
    expect((await call('DELETE', `/projects/${project.id}`)).statusCode).toBe(204)
    expect(writer.hooks.size).toBe(0)
  })

  it('explique le refus d’un token en lecture seule', async () => {
    const project = await createProject('lecture', reader.url)
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${project.environments[0]!.id}/webhooks/${project.sources[0]!.id}/install`,
    )
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('portée « api »')
    expect(reader.hooks.size).toBe(0)
  })
})
