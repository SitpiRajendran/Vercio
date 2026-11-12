import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parse } from 'yaml'
import type { ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { envVariables, users } from '../src/db/schema.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('Fichier Compose géré par Vercio', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  let cookie: string
  let project: ProjectView

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  beforeAll(async () => {
    ctx = await setupTestApp()
    const [user] = await ctx.db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'a',
        username: 'a',
        displayName: 'a',
        roles: ['vercio-admin'],
      })
      .returning()
    const { token } = await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})
    cookie = `__Host-vercio_session=${token}`
    // « Service seul » tel que le crée l'assistant.
    const created = await call('POST', '/projects', {
      name: 'Base de données',
      slug: 'base',
      type: 'single',
      compose: {
        source: 'inline',
        content:
          'services:\n  postgres:\n    image: postgres:17\n    restart: unless-stopped\n    volumes:\n      - postgres-data:/var/lib/postgresql/data\nvolumes:\n  postgres-data: {}\n',
      },
      sources: [],
      trackedServices: [],
      environments: [{ name: 'Production', slug: 'prod', sources: [] }],
    })
    expect(created.statusCode).toBe(201)
    project = created.json()
    await call('PUT', `/projects/${project.id}/variables`, {
      variables: [
        { key: 'POSTGRES_PASSWORD', value: 'admin', secret: true },
        { key: 'POSTGRES_USER', value: 'app', secret: false },
      ],
    })
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('ajoute un service : le projet passe en Compose, postgres garde ses variables', async () => {
    const response = await call('POST', `/projects/${project.id}/compose/services`, {
      name: 'drizzle-gateway',
      image: 'ghcr.io/drizzle-team/gateway:latest',
      port: 4983,
      environment: [
        { key: 'PORT', value: '4983', secret: false },
        { key: 'STORE_PATH', value: '/app', secret: false },
        { key: 'MASTERPASS', value: 'mot-de-passe-maitre', secret: true },
      ],
      dataPath: '/app',
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.type).toBe('compose')
    expect(body.content).not.toContain('mot-de-passe-maitre')
    const compose = parse(body.content)
    // Le service existant reçoit nommément les variables qu'il recevait toutes avant.
    expect(compose.services.postgres.environment).toEqual(['POSTGRES_PASSWORD', 'POSTGRES_USER'])
    // Le nouveau ne reçoit que les siennes ; le secret est une référence.
    expect(compose.services['drizzle-gateway']).toMatchObject({
      image: 'ghcr.io/drizzle-team/gateway:latest',
      expose: ['4983'],
      environment: { PORT: '4983', STORE_PATH: '/app', MASTERPASS: '${MASTERPASS}' },
      volumes: ['drizzle-gateway-data:/app'],
    })
    expect(compose.volumes).toHaveProperty('postgres-data')
    expect(compose.volumes).toHaveProperty('drizzle-gateway-data')
    const [secret] = await ctx.db
      .select()
      .from(envVariables)
      .where(eq(envVariables.key, 'MASTERPASS'))
    expect(secret).toMatchObject({ secret: true, environmentId: null })

    const view = (await call('GET', `/projects/${project.slug}`)).json() as ProjectView
    expect(view.type).toBe('compose')
  })

  it('refuse un nom de service déjà pris', async () => {
    const twice = await call('POST', `/projects/${project.id}/compose/services`, {
      name: 'postgres',
      image: 'postgres:17',
    })
    expect(twice.json()).toMatchObject({ field: 'name' })
  })

  it('modifie le fichier à la main, en refusant un fichier illisible', async () => {
    const bad = await call('PUT', `/projects/${project.id}/compose`, { content: 'services: [' })
    expect(bad.statusCode).toBe(400)
    const ok = await call('PUT', `/projects/${project.id}/compose`, {
      content: '# à la main\nservices:\n  postgres:\n    image: postgres:18\n',
    })
    expect(ok.json()).toMatchObject({ type: 'compose' })
    expect(ok.json().content).toContain('# à la main')
  })
})

describe('Retour arrière d’un « service seul » devenu Compose', () => {
  it('reprend les variables transmises par nom à l’époque', async () => {
    const { passedVariables } = await import('../src/deploy/engine.js')
    const override = [
      'services:',
      '  postgres:',
      '    environment:',
      '      - POSTGRES_PASSWORD',
      '      - POSTGRES_USER',
      '    labels:',
      '      vercio.managed: "true"',
      '',
    ].join('\n')
    expect(passedVariables(override)).toEqual(['POSTGRES_PASSWORD', 'POSTGRES_USER'])
    expect(passedVariables('services:\n  web:\n    labels: {}\n')).toEqual([])
    expect(passedVariables(null)).toBeNull()
  })
})
