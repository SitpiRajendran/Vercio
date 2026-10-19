import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExternalComposeProject } from '@vercio/shared'
import type { ComposeContainer } from '../src/docker/host-driver.js'
import { SessionStore } from '../src/auth/sessions.js'
import { users } from '../src/db/schema.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

function container(
  dir: string,
  service: string,
  extra: Partial<ComposeContainer> = {},
): ComposeContainer {
  return {
    id: `budgie-${service}`,
    name: `budgie-${service}-1`,
    project: 'budgie',
    service,
    image: `budgie/${service}:latest`,
    state: 'running',
    status: 'Up 3 hours',
    labels: {
      'com.docker.compose.project': 'budgie',
      'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': dir,
      'com.docker.compose.project.config_files': join(dir, 'docker-compose.yml'),
    },
    mounts: [],
    ports: [],
    ...extra,
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Import de projets Compose existants', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  let cookie: string
  let dir: string

  beforeAll(async () => {
    ctx = await setupTestApp({}, undefined, host)
    dir = await mkdtemp(join(tmpdir(), 'budgie-'))
    await writeFile(
      join(dir, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres:17\n    volumes: [pgdata:/var/lib/postgresql/data]\n  backend:\n    image: budgie/backend:latest\n    env_file: .env\nvolumes:\n  pgdata: {}\n',
    )
    await writeFile(join(dir, '.env'), 'APP_URL=http://localhost:3000\nSESSION_SECRET=chut\n')
    host.inventory = [
      container(dir, 'db', {
        ports: ['14432→5432/tcp'],
        mounts: [
          {
            type: 'volume',
            name: 'budgie_pgdata',
            source: '/var/lib/docker/volumes/x',
            destination: '/var/lib/postgresql/data',
          },
        ],
      }),
      container(dir, 'backend', {
        mounts: [
          { type: 'bind', name: null, source: join(dir, 'uploads'), destination: '/app/uploads' },
        ],
      }),
      // Conteneur ponctuel (compose run) et projet déjà géré par Vercio : écartés.
      container(dir, 'migrate', {
        labels: { ...container(dir, 'migrate').labels, 'com.docker.compose.oneoff': 'True' },
      }),
      {
        ...container(dir, 'front'),
        project: 'vercio_site_prod',
        labels: { 'vercio.managed': 'true' },
      },
    ]
    const [admin] = await ctx.db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'admin-sso',
        username: 'admin-sso',
        displayName: 'Admin',
        roles: ['vercio-admin'],
      })
      .returning()
    const { token } = await new SessionStore(ctx.db, 3_600_000).create(admin!.id, {})
    cookie = `__Host-vercio_session=${token}`
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('liste les projets lancés hors de Vercio avec leur fichier, leur .env et leurs volumes', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects/imports',
      headers: { cookie, origin: ORIGIN },
    })
    expect(response.statusCode).toBe(200)
    const projects = response.json() as ExternalComposeProject[]
    expect(projects.map((p) => p.name)).toEqual(['budgie'])
    const [budgie] = projects
    expect(budgie).toMatchObject({
      workingDir: dir,
      volumes: [{ key: 'pgdata', name: 'budgie_pgdata', services: ['db'] }],
      relativeBinds: [{ service: 'backend', source: './uploads', target: '/app/uploads' }],
    })
    expect(budgie!.services.map((s) => s.name)).toEqual(['backend', 'db'])
    expect(budgie!.services.find((s) => s.name === 'db')!.ports).toEqual(['14432→5432/tcp'])
    expect(budgie!.compose).toMatchObject({ path: join(dir, 'docker-compose.yml') })
    expect('analysis' in budgie!.compose && budgie!.compose.analysis.error).toBe(null)
    expect(budgie!.env).toMatchObject({
      variables: [
        { key: 'APP_URL', value: 'http://localhost:3000', secret: false },
        { key: 'SESSION_SECRET', value: 'chut', secret: true },
      ],
    })
  })

  it('explique un fichier illisible', async () => {
    host.inventory = [
      {
        ...container('/dossier/absent', 'web'),
        project: 'ailleurs',
        labels: {
          ...container('/dossier/absent', 'web').labels,
          'com.docker.compose.project': 'ailleurs',
        },
      },
    ]
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects/imports',
      headers: { cookie, origin: ORIGIN },
    })
    const [project] = response.json() as ExternalComposeProject[]
    expect(project!.compose).toMatchObject({
      error: expect.stringContaining('importez le fichier'),
    })
    expect(project!.env).toBeNull()
  })
})
