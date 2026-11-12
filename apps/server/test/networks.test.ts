import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { DeploymentDetail, ProjectView, SharedNetworkView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner, RunOptions } from '../src/deploy/command.js'
import { eq } from 'drizzle-orm'
import { auditLogs, envVariables, users } from '../src/db/schema.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

/** Docker simulé : réseaux existants, surcharge Compose lue au moment de `up`. */
class NetworkDocker implements CommandRunner {
  networks = new Set<string>()
  created: string[] = []
  overrides: Record<string, unknown>[] = []
  /** `docker exec` (création de base) : conteneur, script et instructions reçues. */
  execs: { container: string; script: string; input: string }[] = []
  async run(_command: string, args: string[], options: RunOptions) {
    if (args[0] === 'exec') {
      let input = ''
      for await (const chunk of options.stdin ?? []) input += String(chunk)
      this.execs.push({ container: args[2]!, script: args.at(-1)!, input })
      return { code: 0 }
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      return { code: this.networks.has(args.at(-1)!) ? 0 : 1 }
    }
    if (args[0] === 'network' && args[1] === 'create') {
      this.networks.add(args.at(-1)!)
      this.created.push(args.at(-1)!)
      return { code: 0 }
    }
    if (args.includes('up')) {
      this.overrides.push(parse(await readFile(join(options.cwd, 'compose.vercio.yml'), 'utf8')))
    }
    return { code: 0 }
  }
}

const POSTGRES = 'services:\n  db:\n    image: postgres:17\n  backup:\n    image: alpine\n'
const SITE = [
  'services:',
  '  web:',
  '    image: nginx',
  '  worker:',
  '    image: alpine',
  '    networks: [interne]',
  '  monitor:',
  '    image: alpine',
  '    network_mode: host',
  'networks:',
  '  interne: {}',
  '',
].join('\n')

describe.skipIf(!TEST_DATABASE_URL)('Réseaux partagés', () => {
  const docker = new NetworkDocker()
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}
  let postgres: ProjectView
  /** Projet base-liee : sa base sert aux tests de liaison suivants. */
  let linkedBase: ProjectView
  let site: ProjectView

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    role = 'admin',
  ) =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  async function createProject(slug: string, content: string): Promise<ProjectView> {
    const response = await call('POST', '/projects', {
      name: slug,
      slug,
      type: 'compose',
      compose: { source: 'inline', content },
      sources: [],
      trackedServices: [],
      environments: [{ name: 'Production', slug: 'prod', sources: [] }],
    })
    expect(response.statusCode).toBe(201)
    return response.json()
  }

  async function deploy(project: ProjectView): Promise<DeploymentDetail> {
    const env = project.environments[0]!
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${env.id}/deployments`,
    )
    expect(response.statusCode).toBe(202)
    await ctx.app.deployments.idle()
    return (await call('GET', `/deployments/${response.json().id}`)).json()
  }

  beforeAll(async () => {
    ctx = await setupTestApp({}, docker, host)
    for (const [role, roles] of [
      ['admin', ['vercio-admin']],
      ['viewer', ['vercio-viewer']],
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
    postgres = await createProject('postgres', POSTGRES)
    site = await createProject('site', SITE)
  })

  afterAll(async () => {
    await ctx?.close()
  })

  let network: SharedNetworkView

  it('crée un réseau partagé exposant un service (admin seulement)', async () => {
    const input = {
      name: 'postgres-prod',
      environmentId: postgres.environments[0]!.id,
      service: 'db',
      alias: 'postgres-prod',
      description: 'Base mutualisée',
    }
    expect((await call('POST', '/networks', input, 'viewer')).statusCode).toBe(403)
    expect((await call('POST', '/networks', { ...input, name: 'Postgres' })).json()).toMatchObject({
      field: 'name',
    })
    const response = await call('POST', '/networks', input)
    expect(response.statusCode).toBe(201)
    network = response.json()
    expect(network).toMatchObject({
      dockerName: 'vercio-shared-postgres-prod',
      alias: 'postgres-prod',
      exposedBy: { projectSlug: 'postgres', environmentSlug: 'prod', service: 'db' },
      subscribers: [],
      docker: { exists: false, containers: [] },
    })
    expect((await call('POST', '/networks', input)).statusCode).toBe(409)
    expect((await call('POST', '/networks', { ...input, name: 'autre' })).json()).toMatchObject({
      field: 'alias',
    })
  })

  it('expose le service sous son alias au déploiement, en créant le réseau', async () => {
    const result = await deploy(postgres)
    expect(result.status).toBe('succeeded')
    expect(docker.created).toEqual(['vercio-shared-postgres-prod'])
    const override = docker.overrides.at(-1) as {
      services: Record<string, { networks?: unknown }>
      networks: unknown
    }
    expect(override.services.db!.networks).toEqual({
      default: {},
      'vercio-shared-postgres-prod': { aliases: ['postgres-prod'] },
    })
    expect(override.services.backup!.networks).toBeUndefined()
    expect(override.networks).toEqual({
      'vercio-shared-postgres-prod': { name: 'vercio-shared-postgres-prod', external: true },
    })
    // Un service absent du dernier déploiement est refusé.
    expect(
      (await call('PUT', `/networks/${network.id}`, { service: 'inconnu', alias: 'postgres-prod' }))
        .statusCode,
    ).toBe(400)
  })

  it('abonne un environnement : ses services rejoignent le réseau', async () => {
    const url = `/projects/${site.id}/environments/${site.environments[0]!.id}/networks`
    // L'environnement exposant ne peut pas s'abonner à son propre réseau.
    expect(
      (
        await call(
          'PUT',
          `/projects/${postgres.id}/environments/${postgres.environments[0]!.id}/networks`,
          { subscriptions: [{ networkId: network.id, services: null }] },
        )
      ).statusCode,
    ).toBe(400)
    const response = await call('PUT', url, {
      subscriptions: [{ networkId: network.id, services: null }],
    })
    expect(response.statusCode).toBe(200)
    expect((await call('GET', '/networks', undefined, 'viewer')).json()[0].subscribers).toEqual([
      expect.objectContaining({ projectSlug: 'site', environmentSlug: 'prod', services: null }),
    ])

    const result = await deploy(site)
    expect(result.status).toBe('succeeded')
    // Réseau déjà créé : pas recréé.
    expect(docker.created).toEqual(['vercio-shared-postgres-prod'])
    const override = docker.overrides.at(-1) as {
      services: Record<string, { networks?: unknown }>
    }
    expect(override.services.web!.networks).toEqual({
      default: {},
      'vercio-shared-postgres-prod': {},
    })
    // Réseaux déclarés dans le Compose : gardés (fusion), sans ajout de `default`.
    expect(override.services.worker!.networks).toEqual({ 'vercio-shared-postgres-prod': {} })
    // network_mode: host ne peut rejoindre aucun réseau.
    expect(override.services.monitor!.networks).toBeUndefined()
    expect(result.logs.map((line) => line.line)).toContainEqual(
      expect.stringContaining('web, worker joignent postgres-prod'),
    )

    // Abonnement limité à un service.
    await call('PUT', url, { subscriptions: [{ networkId: network.id, services: ['web'] }] })
    await deploy(site)
    const limited = docker.overrides.at(-1) as { services: Record<string, { networks?: unknown }> }
    expect(limited.services.worker!.networks).toBeUndefined()
  })

  it('refuse le déploiement si le service exposé a disparu du fichier Compose', async () => {
    await call('PUT', `/projects/${postgres.id}`, {
      name: 'postgres',
      slug: 'postgres',
      type: 'compose',
      compose: { source: 'inline', content: 'services:\n  pg:\n    image: postgres:17\n' },
      sources: [],
      trackedServices: [],
    })
    const result = await deploy(postgres)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('« db », exposé sur le réseau partagé postgres-prod')
  })

  it('montre les conteneurs attachés et supprime le réseau', async () => {
    host.dockerNetworks.set('vercio-shared-postgres-prod', [
      { name: 'vercio_site_prod-web-1', project: 'vercio_site_prod' },
    ])
    const [view] = (
      await call('GET', '/networks', undefined, 'viewer')
    ).json() as SharedNetworkView[]
    expect(view!.docker).toEqual({
      exists: true,
      containers: [{ name: 'vercio_site_prod-web-1', project: 'vercio_site_prod' }],
    })
    // Des conteneurs y sont encore attachés : le réseau Docker reste jusqu'à leur redéploiement.
    expect((await call('DELETE', `/networks/${network.id}`)).json()).toEqual({ docker: 'in_use' })
    expect((await call('GET', '/networks')).json()).toEqual([])
    const actions = (await ctx.db.select().from(auditLogs)).map((entry) => entry.action)
    expect(actions).toEqual(
      expect.arrayContaining(['network.create', 'environment.networks.update', 'network.delete']),
    )
  })

  it('transmet les variables à un service seul, et signale celles qu’un Compose n’utilise pas', async () => {
    const created = await call('POST', '/projects', {
      name: 'Base',
      slug: 'base',
      type: 'single',
      compose: { source: 'inline', content: 'services:\n  postgres:\n    image: postgres:17\n' },
      sources: [],
      trackedServices: [],
      environments: [{ name: 'Production', slug: 'prod', sources: [] }],
    })
    const base = created.json() as ProjectView
    const env = base.environments[0]!
    await call('PUT', `/projects/${base.id}/variables`, {
      variables: [
        { key: 'POSTGRES_PASSWORD', value: 'partagé-123', secret: true },
        { key: 'POSTGRES_USER', value: 'app', secret: false },
      ],
    })
    await call('PUT', `/projects/${base.id}/variables?environment=${env.id}`, {
      variables: [{ key: 'POSTGRES_PASSWORD', value: 'prod-456', secret: true }],
    })
    const result = await deploy(base)
    expect(result.status).toBe('succeeded')
    const override = docker.overrides.at(-1) as {
      services: Record<string, { environment?: string[] }>
    }
    expect(override.services.postgres!.environment).toEqual(['POSTGRES_PASSWORD', 'POSTGRES_USER'])
    const lines = result.logs.map((line) => line.line)
    expect(lines).toContainEqual(
      'Variables : POSTGRES_PASSWORD (environnement, remplace la partagée), POSTGRES_USER (partagée)',
    )
    expect(lines).toContainEqual(
      'Variables transmises aux conteneurs : POSTGRES_PASSWORD, POSTGRES_USER',
    )
    expect(JSON.stringify(lines)).not.toContain('prod-456')

    // Projet Compose : les variables non utilisées sont signalées, pas injectées.
    await call('PUT', `/projects/${site.id}/variables`, {
      variables: [{ key: 'INUTILE', value: 'x', secret: false }],
    })
    const siteResult = await deploy(site)
    expect(siteResult.logs.map((line) => line.line)).toContainEqual(
      expect.stringContaining(
        'non utilisées par le fichier Compose, donc absentes des conteneurs : INUTILE',
      ),
    )
    const siteOverride = docker.overrides.at(-1) as {
      services: Record<string, { environment?: string[] }>
    }
    expect(siteOverride.services.web!.environment).toBeUndefined()
  })
  it('connecte un projet au service d’un autre en une fois, conteneurs branchés tout de suite', async () => {
    const base = (linkedBase = await createProject(
      'base-liee',
      'services:\n  postgres:\n    image: postgres:17\n',
    ))
    const web = await createProject(
      'web-lie',
      'services:\n  api:\n    image: nginx\n  front:\n    image: nginx\n',
    )
    await deploy(base)
    await deploy(web)
    const running = (id: string, service: string, name: string) => ({
      id,
      name,
      service,
      image: 'x',
      state: 'running',
      status: 'Up',
      health: null,
      createdAt: new Date().toISOString(),
      ports: [],
    })
    host.containers.set('vercio_base-liee_prod', [running('b'.repeat(12), 'postgres', 'base-pg')])
    host.containers.set('vercio_web-lie_prod', [
      running('a'.repeat(12), 'api', 'web-api'),
      running('c'.repeat(12), 'front', 'web-front'),
    ])
    const env = web.environments[0]!
    const link = (payload: object) =>
      call('POST', `/projects/${web.id}/environments/${env.id}/links`, payload)

    const own = await link({
      targetEnvironmentId: env.id,
      service: 'api',
      alias: 'moi-meme',
      services: null,
    })
    expect(own.statusCode).toBe(400)
    const unknown = await link({
      targetEnvironmentId: base.environments[0]!.id,
      service: 'absent',
      alias: 'base-db',
      services: null,
    })
    expect(unknown.json()).toMatchObject({ field: 'service' })

    const response = await link({
      targetEnvironmentId: base.environments[0]!.id,
      service: 'postgres',
      alias: 'base-db',
      services: ['api'],
    })
    expect(response.statusCode).toBe(201)
    const result = response.json()
    expect(result).toMatchObject({
      applied: true,
      detail: null,
      network: {
        alias: 'base-db',
        exposedBy: { projectSlug: 'base-liee', service: 'postgres' },
        subscribers: [{ projectSlug: 'web-lie', services: ['api'] }],
      },
    })
    // Réseau propre à la liaison, nommé d'après le projet qui se connecte.
    expect(result.network.name).toBe('web-lie-base-db')
    const network = 'vercio-shared-web-lie-base-db'
    expect(host.connected.filter((item) => item.network === network)).toEqual([
      { network, id: 'b'.repeat(12), aliases: ['base-db'] },
      { network, id: 'a'.repeat(12), aliases: [] },
    ])

    // Deuxième liaison au même service : le réseau existant est réutilisé, avec son nom.
    const again = await link({
      targetEnvironmentId: base.environments[0]!.id,
      service: 'postgres',
      alias: 'autre-nom',
      services: null,
    })
    expect(again.json().network).toMatchObject({ id: result.network.id, alias: 'base-db' })
    expect(again.json().network.subscribers).toEqual([
      expect.objectContaining({ projectSlug: 'web-lie', services: null }),
    ])
    expect(
      (
        await call(
          'POST',
          `/projects/${web.id}/environments/${env.id}/links`,
          {
            targetEnvironmentId: base.environments[0]!.id,
            service: 'postgres',
            alias: 'base-db',
            services: null,
          },
          'viewer',
        )
      ).statusCode,
    ).toBe(403)
  })

  it('isole chaque liaison : deux projets reliés à la même base ne se voient pas', async () => {
    const base = linkedBase
    const autre = await createProject('autre-app', 'services:\n  backend:\n    image: nginx\n')
    await deploy(autre)
    const response = await call(
      'POST',
      `/projects/${autre.id}/environments/${autre.environments[0]!.id}/links`,
      {
        targetEnvironmentId: base.environments[0]!.id,
        service: 'postgres',
        // Même nom que la liaison de web-lie : permis, chaque projet a ses propres noms.
        alias: 'base-db',
        services: ['backend'],
      },
    )
    expect(response.statusCode).toBe(201)
    const network = response.json().network
    expect(network.name).toBe('autre-app-base-db')
    expect(network.subscribers).toEqual([
      expect.objectContaining({ projectSlug: 'autre-app', services: ['backend'] }),
    ])
    const networks = (await call('GET', '/networks')).json() as SharedNetworkView[]
    const toPostgres = networks.filter((item) => item.exposedBy.projectSlug === 'base-liee')
    // Aucun réseau ne contient deux projets clients.
    for (const item of toPostgres) expect(item.subscribers.length).toBeLessThanOrEqual(1)
    expect(toPostgres.length).toBeGreaterThanOrEqual(2)

    // Nouvelle demande vers le même service : la liaison existante est réutilisée.
    const reused = await call(
      'POST',
      `/projects/${autre.id}/environments/${autre.environments[0]!.id}/links`,
      {
        targetEnvironmentId: base.environments[0]!.id,
        service: 'postgres',
        alias: 'backend',
        services: null,
      },
    )
    expect(reused.statusCode).toBe(201)
    expect(reused.json().network.alias).toBe('base-db')
  })

  it('crée une base et un utilisateur dédiés, enregistre la variable et propose les cibles', async () => {
    const base = linkedBase
    const app = await createProject('planny-test', 'services:\n  backend:\n    image: nginx\n')
    await deploy(app)
    const env = app.environments[0]!

    const targets = (
      await call('GET', `/projects/${app.id}/environments/${env.id}/link-targets`)
    ).json()
    expect(targets).toContainEqual(
      expect.objectContaining({
        projectSlug: 'base-liee',
        service: 'postgres',
        kind: 'postgres',
        port: 5432,
        running: true,
        linkedAs: null,
      }),
    )
    expect(
      targets.some((item: { projectSlug: string }) => item.projectSlug === 'planny-test'),
    ).toBe(false)

    docker.execs = []
    const response = await call('POST', `/projects/${app.id}/environments/${env.id}/links`, {
      targetEnvironmentId: base.environments[0]!.id,
      service: 'postgres',
      alias: 'postgres',
      services: ['backend'],
      access: 'dedicated',
      variable: 'DATABASE_URL',
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      database: { name: 'planny_test', user: 'planny_test' },
      variable: 'DATABASE_URL',
    })
    // Instructions envoyées sur l'entrée standard, jamais en argument.
    const exec = docker.execs[0]!
    expect(exec.container).toBe('b'.repeat(12))
    expect(exec.input).toContain('CREATE DATABASE "planny_test" OWNER "planny_test"')
    // Les autres applications ne peuvent pas se connecter à cette base.
    expect(exec.input).toContain('REVOKE ALL ON DATABASE "planny_test" FROM PUBLIC')
    const password = /PASSWORD '([A-Za-z0-9]+)'/.exec(exec.input)![1]!
    expect(exec.script).not.toContain(password)

    // Variable secrète, jamais renvoyée en clair.
    const variables = (
      await call('GET', `/projects/${app.id}/variables?environment=${env.id}`)
    ).json()
    const variable = variables.find((item: { key: string }) => item.key === 'DATABASE_URL')
    expect(variable).toMatchObject({ secret: true, value: null })
    expect(JSON.stringify(variables)).not.toContain(password)
    const [row] = await ctx.db
      .select()
      .from(envVariables)
      .where(eq(envVariables.key, 'DATABASE_URL'))
    expect(ctx.app.deployments).toBeDefined()
    const { SecretBox } = await import('../src/lib/crypto.js')
    expect(new SecretBox('x'.repeat(32)).decrypt(row!.valueEnc)).toBe(
      `postgresql://planny_test:${password}@postgres:5432/planny_test`,
    )
  })
})
