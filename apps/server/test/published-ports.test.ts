import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { DeploymentDetail, ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner, RunOptions } from '../src/deploy/command.js'
import { analyzeCompose } from '../src/compose/analyze.js'
import { addPublishedPorts, pageRelays } from '../src/deploy/published-ports.js'
import { users } from '../src/db/schema.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

describe('addPublishedPorts', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: nginx',
    '    ports: ["127.0.0.1:8080:80"]',
    '  api:',
    '    image: node',
    '  agent:',
    '    image: alpine',
    '    network_mode: host',
    '',
  ].join('\n')

  it('ajoute les ports à la suite de ceux du service, sur toutes les interfaces', () => {
    const result = addPublishedPorts(compose, [
      { service: 'web', published: 80, target: 80, protocol: 'tcp', page: false },
      { service: 'api', published: 3000, target: 3701, protocol: 'tcp', page: false },
      { service: 'api', published: 5353, target: 53, protocol: 'udp', page: false },
    ])
    expect(result.skipped).toEqual([])
    const services = parse(result.compose).services
    expect(services.web.ports).toEqual(['127.0.0.1:8080:80', '80:80'])
    expect(services.api.ports).toEqual(['3000:3701', '5353:53/udp'])
  })

  it('ignore un service absent ou en network_mode', () => {
    const result = addPublishedPorts(compose, [
      { service: 'absent', published: 1, target: 1, protocol: 'tcp', page: false },
      { service: 'agent', published: 2, target: 2, protocol: 'tcp', page: false },
    ])
    expect(result.skipped.map((item) => item.rule.service)).toEqual(['absent', 'agent'])
    expect(parse(result.compose).services.agent.ports).toBeUndefined()
  })
})

describe('Clés de fusion YAML (<<: *commun)', () => {
  const compose = [
    'x-app: &app',
    '  image: registry.example.com/front:main',
    '  env_file: .env',
    '  ports: ["4000:3700"]',
    'services:',
    '  frontend:',
    '    <<: *app',
    '',
  ].join('\n')

  it('lit l’image héritée, comme Docker Compose', () => {
    const analysis = analyzeCompose(compose)
    expect(analysis.error).toBeNull()
    expect(analysis.services[0]).toMatchObject({
      name: 'frontend',
      image: 'registry.example.com/front:main',
      envFile: true,
    })
  })

  it('garde les ports hérités quand Vercio en ajoute', () => {
    const result = addPublishedPorts(compose, [
      { service: 'frontend', published: 8080, target: 3700, protocol: 'tcp', page: false },
    ])
    expect(parse(result.compose, { merge: true }).services.frontend.ports).toEqual([
      '4000:3700',
      '8080:3700',
    ])
  })
})

describe('pageRelays', () => {
  const compose =
    'services:\n  web:\n    image: nginx\n    networks: [front]\n  api:\n    image: node\n'
  const rule = (service: string, published: number, page = true) => ({
    service,
    published,
    target: 80,
    protocol: 'tcp' as const,
    page,
  })

  it('confie les ports avec page à un relais dédié, ou au relais sans coupure du service', () => {
    const zero = { services: ['api'], relays: [] as Parameters<typeof pageRelays>[2]['relays'] }
    const relays = pageRelays(
      compose,
      [rule('web', 8080), rule('web', 8081), rule('api', 9090), rule('web', 7070, false)],
      zero,
    )
    expect(relays).toEqual([
      {
        service: 'web',
        name: 'vercio-page-web',
        networks: ['front'],
        ports: [
          { hostIp: null, published: 8080, target: 80 },
          { hostIp: null, published: 8081, target: 80 },
        ],
      },
    ])
    expect(zero.relays).toEqual([
      {
        service: 'api',
        name: 'vercio-relay-api',
        networks: null,
        ports: [{ hostIp: null, published: 9090, target: 80 }],
      },
    ])
  })
})

/** Docker simulé : fichier Compose lu au moment de `up`. */
class ComposeDocker implements CommandRunner {
  composes: Record<string, { ports?: string[] }>[] = []
  overrides: Record<string, { ports?: string[]; image?: string }>[] = []
  relayConfigs: Record<string, string> = {}
  async run(_command: string, args: string[], options: RunOptions) {
    if (args.includes('up')) {
      this.composes.push(parse(await readFile(join(options.cwd, 'compose.yml'), 'utf8')).services)
      const override = parse(await readFile(join(options.cwd, 'compose.vercio.yml'), 'utf8'))
      this.overrides.push(override.services)
      for (const name of Object.keys(override.services)) {
        if (!name.startsWith('vercio-')) continue
        this.relayConfigs[name] = await readFile(
          join(options.cwd, '.vercio', `${name}.conf`),
          'utf8',
        )
      }
    }
    return { code: 0 }
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Ports ouverts depuis Vercio', () => {
  const docker = new ComposeDocker()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}

  const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, role = 'admin') =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  async function createProject(slug: string): Promise<ProjectView> {
    const response = await call('POST', '/projects', {
      name: slug,
      slug,
      type: 'compose',
      compose: {
        source: 'inline',
        content: 'services:\n  frontend:\n    image: nginx\n  backend:\n    image: node\n',
      },
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
    ctx = await setupTestApp({}, docker, new FakeHost())
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
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('ouvre un port au prochain déploiement, sans conflit entre environnements', async () => {
    const site = await createProject('site-ports')
    const other = await createProject('autre-ports')
    await deploy(site)
    const env = site.environments[0]!
    const ports = (payload: object, role = 'admin', project = site) =>
      call(
        'PUT',
        `/projects/${project.id}/environments/${project.environments[0]!.id}/ports`,
        payload,
        role,
      )

    const rule = {
      service: 'frontend',
      published: 3700,
      target: 3700,
      protocol: 'tcp',
      page: false,
    }
    expect((await ports({ ports: [rule] }, 'deployer')).statusCode).toBe(403)
    expect((await ports({ ports: [{ ...rule, service: 'absent' }] })).json()).toMatchObject({
      field: 'service',
    })
    expect((await ports({ ports: [rule, rule] })).statusCode).toBe(400)

    const saved = await ports({ ports: [rule] })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().environments[0].publishedPorts).toEqual([rule])

    // Le même port ne peut pas être ouvert pour un autre projet.
    const conflict = await ports({ ports: [rule] }, 'admin', other)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toContain('site-ports')

    const result = await deploy(site)
    expect(result.status).toBe('succeeded')
    expect(docker.composes.at(-1)!.frontend!.ports).toEqual(['3700:3700'])
    expect(result.logs.map((line) => line.line)).toContainEqual(
      'Port 3700 ouvert vers frontend:3700',
    )
    void env

    // Page d'attente : le port passe par un relais nginx, plus par le service.
    await ports({
      ports: [
        rule,
        { service: 'backend', published: 8080, target: 3701, protocol: 'tcp', page: true },
      ],
    })
    const withPage = await deploy(site)
    expect(withPage.status).toBe('succeeded')
    expect(docker.composes.at(-1)!.backend!.ports).toBeUndefined()
    expect(docker.overrides.at(-1)!['vercio-page-backend']).toMatchObject({
      ports: ['8080:3701'],
    })
    const config = docker.relayConfigs['vercio-page-backend']!
    expect(config).toContain('proxy_pass http://$vercio_upstream:3701')
    expect(config).toContain('error_page 502 503 504 = @vercio_down')
    expect(config).toContain('Site momentanément indisponible')
  })
})
