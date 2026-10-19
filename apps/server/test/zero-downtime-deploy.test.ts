import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { DeploymentDetail, ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner, RunOptions } from '../src/deploy/command.js'
import { users } from '../src/db/schema.js'
import { ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

interface FakeContainer {
  id: string
  service: string
  state: string
  health: string
}

/** Docker simulé avec un état des conteneurs : `--scale` ajoute, `rm` retire. */
class ContainerDocker implements CommandRunner {
  containers: FakeContainer[] = []
  commands: string[][] = []
  files: { compose: string; override: string; relay: string | null }[] = []
  /** Prochaine nouvelle version de ce service : unhealthy. */
  unhealthy = new Set<string>()
  #next = 1

  #create(service: string) {
    const health = this.unhealthy.has(service) ? 'unhealthy' : 'healthy'
    this.unhealthy.delete(service)
    this.containers.push({ id: `c${this.#next++}`, service, state: 'running', health })
  }

  async run(_command: string, args: string[], options: RunOptions) {
    this.commands.push(args)
    const label = (key: string) =>
      args
        .find((arg) => arg.startsWith(`label=${key}=`))
        ?.split('=')
        .at(-1)
    if (args[0] === 'ps') {
      const relayFor = label('vercio.relay-for')
      if (relayFor) {
        const relay = this.containers.find((c) => c.service === `vercio-relay-${relayFor}`)
        if (relay) options.onLine(relay.id, 'stdout')
        return { code: 0 }
      }
      const service = label('com.docker.compose.service')
      for (const item of this.containers.filter((c) => c.service === service)) {
        options.onLine(`${item.id} ${item.state} site-${item.service}-${item.id}`, 'stdout')
      }
    } else if (args[0] === 'inspect') {
      for (const id of args.slice(3)) {
        const item = this.containers.find((c) => c.id === id)
        if (item) options.onLine(`${item.id} ${item.state} ${item.health}`, 'stdout')
      }
    } else if (args[0] === 'rm') {
      const ids = args.filter((arg) => !arg.startsWith('--') && arg !== 'rm')
      this.containers = this.containers.filter((c) => !ids.includes(c.id))
    } else if (args[0] === 'compose' && args.includes('up')) {
      const read = async (name: string) => {
        const path = join(options.cwd, name)
        return existsSync(path) ? readFile(path, 'utf8') : null
      }
      this.files.push({
        compose: (await read('compose.yml'))!,
        override: (await read('compose.vercio.yml'))!,
        relay: await read('.vercio/vercio-relay-web.conf'),
      })
      const scale = args.indexOf('--scale')
      if (scale !== -1) {
        const [service, count] = args[scale + 1]!.split('=')
        const current = this.containers.filter((c) => c.service === service).length
        for (let i = current; i < Number(count); i++) this.#create(service!)
      } else {
        const listed = args.slice(args.indexOf('up') + 1).filter((arg) => !arg.startsWith('-'))
        const services = listed.filter((arg) => !/^\d+$/.test(arg))
        for (const service of services.length ? services : ['web', 'worker', 'vercio-relay-web']) {
          if (!this.containers.some((c) => c.service === service)) this.#create(service)
        }
      }
    }
    return { code: 0 }
  }
}

const COMPOSE = `services:
  web:
    image: nginx
    ports: ["8080:80"]
    healthcheck:
      test: ["CMD", "true"]
  worker:
    image: alpine
`

describe.skipIf(!TEST_DATABASE_URL)('Mise à jour sans coupure', () => {
  const docker = new ContainerDocker()
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

  async function deploy(): Promise<DeploymentDetail> {
    const env = project.environments[0]!
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${env.id}/deployments`,
    )
    await ctx.app.deployments.idle()
    return (await call('GET', `/deployments/${response.json().id}`)).json()
  }

  beforeAll(async () => {
    ctx = await setupTestApp({}, docker)
    const [user] = await ctx.db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'admin',
        username: 'admin',
        displayName: 'admin',
        roles: ['vercio-admin'],
      })
      .returning()
    cookie = `__Host-vercio_session=${(await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})).token}`
    project = (
      await call('POST', '/projects', {
        name: 'Site',
        slug: 'site',
        type: 'compose',
        compose: { source: 'inline', content: COMPOSE },
        sources: [],
        trackedServices: [],
        environments: [{ name: 'Production', slug: 'prod', sources: [] }],
      })
    ).json()
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('indique les services possibles et enregistre le choix (admin)', async () => {
    const compose = (await call('POST', '/catalog/compose/analyze', { content: COMPOSE })).json()
    expect(compose.services[0].zeroDowntime).toEqual({
      eligible: true,
      reason: null,
      warning: null,
    })
    const updated = await call('PUT', `/projects/${project.id}/zero-downtime`, {
      services: ['web', 'web'],
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().zeroDowntimeServices).toEqual(['web'])
  })

  it('premier déploiement : relais en place, ports du service repris par le relais', async () => {
    const result = await deploy()
    expect(result.status).toBe('succeeded')
    const files = docker.files.at(-1)!
    expect((parse(files.compose) as { services: { web: object } }).services.web).not.toHaveProperty(
      'ports',
    )
    const override = parse(files.override) as { services: Record<string, Record<string, unknown>> }
    expect(override.services['vercio-relay-web']).toMatchObject({
      image: 'nginx:1.27-alpine',
      pull_policy: 'missing',
      ports: ['8080:80'],
      volumes: ['./.vercio/vercio-relay-web.conf:/etc/nginx/conf.d/default.conf:ro'],
      labels: expect.objectContaining({ 'vercio.relay-for': 'web' }),
    })
    expect(files.relay).toContain('proxy_pass http://$vercio_upstream:80;')
    // Le relais n'est pas retéléchargé à chaque déploiement.
    const pull = docker.commands.find((args) => args.includes('pull'))!
    expect(pull.slice(pull.indexOf('pull'))).toEqual(['pull', '--quiet', 'web', 'worker'])
    expect(docker.containers.map((c) => c.service).sort()).toEqual([
      'vercio-relay-web',
      'web',
      'worker',
    ])
  })

  it('déploiements suivants : nouvelle version prête avant l’arrêt de l’ancienne', async () => {
    const before = docker.containers.find((c) => c.service === 'web')!.id
    docker.commands = []
    const result = await deploy()
    expect(result.status).toBe('succeeded')
    const sequence = docker.commands.map((args) =>
      args[0] === 'compose'
        ? `compose ${args.slice(args.indexOf('up')).join(' ')}`
        : (args[0] ?? ''),
    )
    const scale = sequence.findIndex((line) => line.includes('--scale web=2'))
    const stop = sequence.indexOf('stop')
    const others = sequence.findIndex((line) => line.includes('--no-deps --wait'))
    expect(scale).toBeGreaterThan(-1)
    expect(sequence.indexOf('inspect')).toBeGreaterThan(scale)
    expect(stop).toBeGreaterThan(sequence.indexOf('inspect'))
    expect(others).toBeGreaterThan(stop)
    // Relais rechargé vers la nouvelle version avant l'arrêt de l'ancienne, puis vers le service.
    const reloads = sequence
      .map((line, index) => (line === 'exec' ? index : -1))
      .filter((index) => index !== -1)
    expect(reloads).toHaveLength(2)
    expect(reloads[0]).toBeLessThan(stop)
    expect(reloads[1]).toBeGreaterThan(stop)
    expect(sequence[others]).toContain('worker vercio-relay-web')
    expect(sequence[others]).not.toMatch(/ web( |$)/)
    const web = docker.containers.filter((c) => c.service === 'web')
    expect(web).toHaveLength(1)
    expect(web[0]!.id).not.toBe(before)
    expect(result.logs.map((line) => line.line)).toContainEqual('✔ web mis à jour sans coupure')
  })

  it('nouvelle version en échec : supprimée, l’ancienne reste en service', async () => {
    const before = docker.containers.find((c) => c.service === 'web')!.id
    docker.unhealthy.add('web')
    const result = await deploy()
    expect(result.status).not.toBe('succeeded')
    expect(result.error).toContain(
      'web : la nouvelle version est unhealthy ; l’ancienne version est restée en service',
    )
    // Le retour automatique repasse par une bascule réussie : un seul conteneur web.
    const web = docker.containers.filter((c) => c.service === 'web')
    expect(web).toHaveLength(1)
    expect(docker.containers.some((c) => c.health === 'unhealthy')).toBe(false)
    expect(before).toBeTruthy()
  })
})
