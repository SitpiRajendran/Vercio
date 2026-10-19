import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql as rawSql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { SessionStore } from '../src/auth/sessions.js'
import {
  GITHUB_CLASSIC_TOKEN,
  GITLAB_TOKEN,
  REGISTRY_PASSWORD,
  REGISTRY_USER,
  startFakeGitHub,
  startFakeGitLab,
  startFakeRegistry,
} from './fake-services.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('API — paramètres', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let admin: string
  let viewer: string
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  let registry: Awaited<ReturnType<typeof startFakeRegistry>>

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
    cookie = admin,
  ) {
    return app.inject({
      method,
      url: `/api/settings${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })
  }

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
    admin = await sessionFor('admin-sso', ['vercio-admin'])
    viewer = await sessionFor('viewer-sso', ['vercio-viewer'])
    gitlab = await startFakeGitLab()
    registry = await startFakeRegistry('bearer')
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await gitlab?.close()
    await registry?.close()
    await close?.()
  })

  it('réserve les paramètres aux administrateurs', async () => {
    expect((await call('GET', '/git-providers', undefined, viewer)).statusCode).toBe(403)
    expect((await call('GET', '/git-providers', undefined, '')).statusCode).toBe(401)
  })

  it('teste un fournisseur GitLab avant de l’enregistrer', async () => {
    const response = await call('POST', '/git-providers/test', {
      name: 'GitLab',
      type: 'gitlab',
      url: `${gitlab.url}/`,
      token: GITLAB_TOKEN,
    })
    expect(response.json()).toMatchObject({ ok: true })
  })

  let providerId: string

  it('enregistre un fournisseur sans jamais renvoyer le token', async () => {
    const response = await call('POST', '/git-providers', {
      name: 'GitLab interne',
      type: 'gitlab',
      url: `${gitlab.url}/`,
      token: GITLAB_TOKEN,
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    providerId = body.id
    expect(body).toMatchObject({ url: gitlab.url, tokenHint: 'glpa…1234', usedBy: 0 })
    expect(JSON.stringify(body)).not.toContain(GITLAB_TOKEN)

    const [row] = await db.execute<{ token_enc: string }>(
      rawSql`select token_enc from git_providers where id = ${providerId}`,
    )
    expect(row?.token_enc).not.toContain(GITLAB_TOKEN)
  })

  it('refuse un nom en double et une URL invalide', async () => {
    const duplicate = await call('POST', '/git-providers', {
      name: 'GitLab interne',
      type: 'gitlab',
      url: gitlab.url,
      token: 'x',
    })
    expect(duplicate.statusCode).toBe(409)
    const invalid = await call('POST', '/git-providers', {
      name: 'X',
      type: 'gitlab',
      url: 'pas une url',
      token: 'x',
    })
    expect(invalid.json()).toMatchObject({ field: 'url' })
  })

  it('conserve le token si on le laisse vide en modification', async () => {
    const updated = await call('PUT', `/git-providers/${providerId}`, {
      name: 'GitLab interne',
      type: 'gitlab',
      url: gitlab.url,
    })
    expect(updated.json()).toMatchObject({ tokenHint: 'glpa…1234' })
    // Changer d'adresse sans ressaisir le token : refusé (il partirait vers la nouvelle adresse).
    const moved = await call('PUT', `/git-providers/${providerId}`, {
      name: 'GitLab interne',
      type: 'gitlab',
      url: 'https://gitlab.ailleurs.example',
    })
    expect(moved.statusCode).toBe(400)
    expect(moved.json()).toMatchObject({ field: 'token' })
    const test = await call('POST', `/git-providers/${providerId}/test`)
    expect(test.json()).toMatchObject({ ok: true })
    const list = await call('GET', '/git-providers')
    expect(list.json()[0].lastCheck).toMatchObject({ ok: true })

    // Formulaire : le token enregistré sert au test vers la même adresse, jamais vers une autre.
    const form = { id: providerId, name: 'GitLab interne', type: 'gitlab' }
    const same = await call('POST', '/git-providers/test', { ...form, url: gitlab.url })
    expect(same.json()).toMatchObject({ ok: true })
    const elsewhere = await call('POST', '/git-providers/test', {
      ...form,
      url: 'https://piege.example.com',
    })
    expect(elsewhere.statusCode).toBe(400)
    expect(elsewhere.json()).toMatchObject({ field: 'token' })
  })

  it('teste un registry GitLab avec le token du fournisseur lié', async () => {
    const response = await call('POST', '/registries/test', {
      name: 'Registry GitLab',
      type: 'gitlab',
      url: registry.url,
      gitProviderId: providerId,
    })
    // Le faux registry n'accepte que REGISTRY_USER / REGISTRY_PASSWORD :
    // le token GitLab est bien transmis mais refusé, ce qui prouve qu'il est utilisé.
    expect(response.json()).toMatchObject({
      ok: false,
      message: 'Identifiants refusés par le registry',
    })
  })

  it('enregistre et teste un registry privé', async () => {
    const created = await call('POST', '/registries', {
      name: 'Registry privé',
      type: 'oci',
      url: registry.url,
      username: REGISTRY_USER,
      password: REGISTRY_PASSWORD,
      insecure: true,
    })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(body).toMatchObject({ hasPassword: true, username: REGISTRY_USER })
    expect(JSON.stringify(body)).not.toContain(REGISTRY_PASSWORD)

    const test = await call('POST', `/registries/${body.id}/test`)
    expect(test.json()).toMatchObject({ ok: true })
    const form = {
      id: body.id,
      name: 'Registry privé',
      type: 'oci',
      username: REGISTRY_USER,
      insecure: true,
    }
    expect(
      (await call('POST', '/registries/test', { ...form, url: registry.url })).json(),
    ).toMatchObject({
      ok: true,
    })
    const elsewhere = await call('POST', '/registries/test', { ...form, url: 'piege.example.com' })
    expect(elsewhere.statusCode).toBe(400)
    expect(elsewhere.json()).toMatchObject({ field: 'password' })

    expect((await call('DELETE', `/registries/${body.id}`)).statusCode).toBe(204)
  })

  it('gère GitHub et refuse un token réutilisé par un registry incompatible', async () => {
    const github = await startFakeGitHub({ enterprise: true })
    try {
      const created = await call('POST', '/git-providers', {
        name: 'GitHub Enterprise',
        type: 'github',
        url: github.url,
        token: GITHUB_CLASSIC_TOKEN,
      })
      expect(created.statusCode).toBe(201)
      const provider = created.json()
      expect(provider).toMatchObject({ type: 'github', tokenHint: 'ghp_…abcd' })
      expect((await call('POST', `/git-providers/${provider.id}/test`)).json()).toMatchObject({
        ok: true,
      })

      // Un registry GitLab ne peut pas réutiliser le token d'un fournisseur GitHub.
      const mismatch = await call('POST', '/registries', {
        name: 'Mauvais lien',
        type: 'gitlab',
        url: 'registry.gitlab.com',
        gitProviderId: provider.id,
      })
      expect(mismatch.json()).toMatchObject({ field: 'gitProviderId' })

      const ghcr = await call('POST', '/registries', {
        name: 'GHCR',
        type: 'ghcr',
        url: 'ghcr.io',
        gitProviderId: provider.id,
      })
      expect(ghcr.statusCode).toBe(201)
      expect((await call('DELETE', `/registries/${ghcr.json().id}`)).statusCode).toBe(204)
      expect((await call('DELETE', `/git-providers/${provider.id}`)).statusCode).toBe(204)
    } finally {
      await github.close()
    }
  })

  it('supprime un fournisseur et journalise les changements', async () => {
    expect((await call('DELETE', `/git-providers/${providerId}`)).statusCode).toBe(204)
    const rows = await db.execute<{ action: string }>(
      rawSql`select action from audit_logs where action like 'settings.%' order by id`,
    )
    expect(rows.map((r) => r.action)).toEqual([
      'settings.git_provider.create',
      'settings.git_provider.update',
      'settings.registry.create',
      'settings.registry.delete',
      'settings.git_provider.create',
      'settings.registry.create',
      'settings.registry.delete',
      'settings.git_provider.delete',
      'settings.git_provider.delete',
    ])
  })

  it('crée le registry d’images avec la connexion GitLab, sur le même token', async () => {
    const created = await call('POST', '/git-providers', {
      name: 'GitLab images',
      type: 'gitlab',
      url: gitlab.url,
      token: GITLAB_TOKEN,
      imageRegistry: { url: 'registry.example.com/' },
    })
    expect(created.statusCode).toBe(201)
    const provider = created.json()
    expect(provider.registries).toEqual([
      { id: expect.any(String), name: 'GitLab images · images', url: 'registry.example.com' },
    ])
    const list = (await call('GET', '/registries')).json() as {
      name: string
      type: string
      gitProviderId: string | null
      hasPassword: boolean
    }[]
    expect(list.find((item) => item.name === 'GitLab images · images')).toMatchObject({
      type: 'gitlab',
      gitProviderId: provider.id,
      hasPassword: false,
    })
    // Fournisseur déjà enregistré : registry ajouté après coup, nom libre trouvé.
    const added = await call('POST', `/git-providers/${provider.id}/registry`, {
      url: 'registry2.example.com',
    })
    expect(added.statusCode).toBe(201)
    expect(added.json().registries.map((item: { name: string }) => item.name)).toEqual([
      'GitLab images · images',
      'GitLab images · images 2',
    ])
    expect(
      (await call('POST', `/git-providers/${provider.id}/registry`, { url: 'x' }, viewer))
        .statusCode,
    ).toBe(403)
  })
})
