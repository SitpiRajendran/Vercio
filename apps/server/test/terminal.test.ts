import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type {
  ContainerInspectView,
  ContainerStatsSample,
  ContainerStatsView,
  TerminalServerMessage,
} from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import { auditLogs, envVariables, environments, hosts, projects, users } from '../src/db/schema.js'
import { SecretBox } from '../src/lib/crypto.js'
import { FakeHost, ORIGIN, setupTestApp, TEST_DATABASE_URL } from './helpers.js'

const RUNNING = 'a'.repeat(64)
const STOPPED = 'b'.repeat(64)
const FOREIGN = 'c'.repeat(64)

function sample(at: string, cpuPercent: number | null): ContainerStatsSample {
  return {
    at,
    cpuPercent,
    memoryBytes: 50_000_000,
    memoryLimitBytes: 1_000_000_000,
    netRxBytes: 1000,
    netTxBytes: 500,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 3,
  }
}

/** Messages reçus par un terminal : contrôle (JSON) et sortie (binaire). */
function collect(socket: WebSocket) {
  const control: TerminalServerMessage[] = []
  let output = ''
  socket.on('message', (data, isBinary) => {
    if (isBinary) output += data.toString()
    else control.push(JSON.parse(data.toString()) as TerminalServerMessage)
  })
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  return { control, output: () => output, closed }
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Statistiques, inspection et terminal', () => {
  const host = new FakeHost()
  let ctx: Awaited<ReturnType<typeof setupTestApp>>
  const cookies: Record<string, string> = {}
  let base = ''

  const call = (method: 'GET' | 'PUT', url: string, role = 'admin', payload?: object) =>
    ctx.app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: cookies[role]!, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  let address = ''
  /** Terminal ouvert sur le serveur à l'écoute ; rejeté si la connexion est refusée. */
  const terminal = (role: string, containerId = RUNNING, query = '', origin = ORIGIN) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(
        `${address.replace('http', 'ws')}/api${base}/containers/${containerId}/terminal${query}`,
        { headers: { cookie: cookies[role]!, origin } },
      )
      socket.on('open', () => resolve(socket))
      socket.on('error', reject)
    })

  beforeAll(async () => {
    ctx = await setupTestApp({}, undefined, host)
    address = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    for (const [role, roles] of [
      ['admin', ['vercio-admin']],
      ['deployer', ['vercio-deployer']],
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
      const { token } = await new SessionStore(ctx.db, 3_600_000).create(user!.id, {})
      cookies[role] = `__Host-vercio_session=${token}`
    }
    const [hostRow] = await ctx.db.select().from(hosts).limit(1)
    const [project] = await ctx.db
      .insert(projects)
      .values({ name: 'Site', slug: 'site', type: 'compose' })
      .returning()
    const [env] = await ctx.db
      .insert(environments)
      .values({ projectId: project!.id, hostId: hostRow!.id, name: 'Production', slug: 'prod' })
      .returning()
    base = `/projects/${project!.id}/environments/${env!.id}`
    const box = new SecretBox('x'.repeat(32))
    await ctx.db.insert(envVariables).values([
      {
        projectId: project!.id,
        key: 'API_KEY_CUSTOM',
        valueEnc: box.encrypt('s3cr3t-value'),
        secret: true,
      },
      {
        projectId: project!.id,
        key: 'PUBLIC_URL',
        valueEnc: box.encrypt('https://site'),
        secret: false,
      },
    ])

    const container = (id: string, service: string, state: string) => ({
      id,
      name: `vercio_site_prod-${service}-1`,
      service,
      image: `acme/${service}:1`,
      state,
      status: state === 'running' ? 'Up 5 minutes' : 'Exited (0)',
      health: null,
      createdAt: '2026-10-01T00:00:00Z',
      ports: [],
    })
    host.containers.set('vercio_site_prod', [
      container(RUNNING, 'web', 'running'),
      container(STOPPED, 'worker', 'exited'),
    ])
    host.containers.set('autre', [container(FOREIGN, 'db', 'running')])
    host.stats.set(RUNNING, [
      sample('2026-10-16T10:00:00Z', null),
      sample('2026-10-16T10:00:01Z', 12.5),
      sample('2026-10-16T10:00:02Z', 13),
      sample('2026-10-16T10:00:06Z', 20),
    ])
    host.details.set(RUNNING, {
      id: RUNNING,
      name: 'vercio_site_prod-web-1',
      service: 'web',
      image: 'acme/web:1',
      imageId: 'sha256:abc',
      createdAt: '2026-10-01T00:00:00Z',
      startedAt: '2026-10-01T00:00:01Z',
      state: 'running',
      restartCount: 0,
      restartPolicy: 'unless-stopped',
      command: ['node', 'server.js', '--key=s3cr3t-value'],
      entrypoint: [],
      workingDir: '/app',
      user: 'node',
      env: [
        { key: 'API_KEY_CUSTOM', value: 's3cr3t-value' },
        { key: 'PUBLIC_URL', value: 'https://site' },
        { key: 'DB_PASSWORD', value: 'hunter22' },
        { key: 'CONNECTION', value: 'postgres://u:s3cr3t-value@db/app' },
        { key: 'NODE_ENV', value: 'production' },
      ],
      mounts: [
        { type: 'volume', source: 'vercio_site_prod_data', destination: '/data', readOnly: false },
      ],
      networks: [{ name: 'vercio_site_prod_default', ip: '172.18.0.2', aliases: ['web'] }],
      ports: ['8080→80/tcp'],
      labels: { 'vercio.project': 'site' },
      health: null,
    })
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('mesure les conteneurs en marche à la demande, une mesure toutes les 5 s', async () => {
    const response = await call('GET', `${base}/containers/stats`, 'viewer')
    expect(response.statusCode).toBe(200)
    const views = response.json() as ContainerStatsView[]
    // Le conteneur arrêté n'est pas mesuré.
    expect(views.map((view) => view.service)).toEqual(['web'])
    // Première mesure sans CPU remplacée ; celle d'une seconde plus tard ignorée.
    expect(views[0]!.samples.map((s) => [s.at, s.cpuPercent])).toEqual([
      ['2026-10-16T10:00:01Z', 12.5],
      ['2026-10-16T10:00:06Z', 20],
    ])
    await call('GET', `${base}/containers/stats`, 'viewer')
    // Un seul flux Docker par conteneur, quel que soit le nombre de consultations.
    expect(host.statsStreams.get(RUNNING)).toBe(1)
    expect(host.statsStreams.get(STOPPED)).toBeUndefined()
  })

  it('inspecte un conteneur de l’environnement en masquant les secrets', async () => {
    const response = await call('GET', `${base}/containers/${RUNNING}`, 'viewer')
    expect(response.statusCode).toBe(200)
    const view = response.json() as ContainerInspectView
    expect(Object.fromEntries(view.env.map((item) => [item.key, item.value]))).toEqual({
      API_KEY_CUSTOM: null,
      PUBLIC_URL: 'https://site',
      DB_PASSWORD: null,
      CONNECTION: null,
      NODE_ENV: 'production',
    })
    expect(view.command).toEqual(['node', 'server.js', '--key=••••••'])
    expect(response.body).not.toContain('s3cr3t-value')
    expect(response.body).not.toContain('hunter22')
    // Conteneur d'un autre projet : refusé, même avec son identifiant.
    expect((await call('GET', `${base}/containers/${FOREIGN}`)).statusCode).toBe(404)
  })

  it('réserve le terminal aux administrateurs, et aux déployeurs si autorisé', async () => {
    await expect(terminal('viewer')).rejects.toThrow(/403/)
    await expect(terminal('deployer')).rejects.toThrow(/403/)
    await expect(terminal('admin', RUNNING, '', 'https://evil.example')).rejects.toThrow(/403/)

    expect((await call('GET', '/settings/terminal', 'viewer')).json()).toEqual({ deployers: false })
    expect(
      (await call('PUT', '/settings/terminal', 'deployer', { deployers: true })).statusCode,
    ).toBe(403)
    expect((await call('PUT', '/settings/terminal', 'admin', { deployers: true })).json()).toEqual({
      deployers: true,
    })
    const socket = await terminal('deployer')
    const session = collect(socket)
    await until(() => session.control.some((message) => message.type === 'ready'))
    socket.close()
    await session.closed
    await call('PUT', '/settings/terminal', 'admin', { deployers: false })
  })

  it('relaie la saisie, le redimensionnement et la sortie, et journalise la session', async () => {
    const socket = await terminal('admin', RUNNING, '?shell=bash&cols=100&rows=30')
    const session = collect(socket)
    socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    socket.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    await until(() => session.output().includes('echo:ls'))
    const exec = host.execs.at(-1)!
    expect(exec).toMatchObject({ id: RUNNING, cmd: ['bash'], cols: 100, rows: 30 })
    expect(exec.resized).toEqual([[120, 40]])

    socket.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
    await session.closed
    expect(session.control).toContainEqual({ type: 'exit', code: 3 })

    // La fin de session est journalisée juste après la fermeture.
    let entries: (typeof auditLogs.$inferSelect)[] = []
    for (let attempt = 0; attempt < 50; attempt++) {
      entries = await ctx.db.select().from(auditLogs)
      if (entries.filter((entry) => entry.action === 'container.terminal.end').length === 2) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const terminalEntries = entries.filter((entry) => entry.action.startsWith('container.terminal'))
    expect(terminalEntries.map((entry) => [entry.action, entry.username, entry.target])).toEqual([
      ['container.terminal', 'deployer', 'site/prod/web'],
      ['container.terminal.end', 'deployer', 'site/prod/web'],
      ['container.terminal', 'admin', 'site/prod/web'],
      ['container.terminal.end', 'admin', 'site/prod/web'],
    ])
    expect(terminalEntries[2]!.details).toEqual({
      container: 'vercio_site_prod-web-1',
      shell: 'bash',
    })
    expect(terminalEntries[3]!.details).toMatchObject({ exitCode: 3 })
    // Le contenu de la session n'est jamais journalisé.
    expect(JSON.stringify(entries)).not.toContain('ls\\r')
  })

  it('refuse un conteneur arrêté ou d’un autre projet', async () => {
    for (const id of [STOPPED, FOREIGN]) {
      const socket = await terminal('admin', id)
      const session = collect(socket)
      await session.closed
      expect(session.control[0]).toMatchObject({ type: 'error' })
    }
  })

  it('ferme le shell quand le navigateur se déconnecte', async () => {
    const socket = await terminal('admin')
    const session = collect(socket)
    await until(() => session.control.some((message) => message.type === 'ready'))
    const exec = host.execs.at(-1)!
    socket.close()
    await until(() => exec.closed)
  })
})
