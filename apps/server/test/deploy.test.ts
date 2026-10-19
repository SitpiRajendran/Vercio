import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parse } from 'yaml'
import type { FastifyInstance } from 'fastify'
import type { DeploymentDetail, DeploymentSummary, ProjectView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner, RunOptions } from '../src/deploy/command.js'
import type { Database } from '../src/db/client.js'
import { appSources, notificationDeliveries, trackedServices, users } from '../src/db/schema.js'
import { GITLAB_TOKEN, startFakeGitLab, startFakeImageRegistry } from './fake-services.js'
import {
  addWatchChannel,
  ORIGIN,
  queuedNotifications,
  setupTestApp,
  TEST_DATABASE_URL,
} from './helpers.js'

interface Call {
  args: string[]
  env: Record<string, string>
  cwd: string
  files: Record<string, string>
}

/** Docker simulé : enregistre les commandes et les fichiers présents au moment de l'appel. */
class FakeDocker implements CommandRunner {
  calls: Call[] = []
  /** Fait échouer `compose up` (conteneur qui ne devient pas sain). */
  failUp = false
  /** Port de l'hôte déjà publié par un autre conteneur. */
  portTaken: { port: string; by: string } | null = null
  /** Projet lancé hors de Vercio : conteneurs en marche et réseaux, par nom de projet. */
  legacy: Record<string, { running: string[]; networks: string[] }> = {}
  async run(command: string, args: string[], options: RunOptions) {
    const files: Record<string, string> = {}
    for (const name of ['compose.yml', 'compose.vercio.yml', '.env']) {
      const path = join(options.cwd, name)
      if (existsSync(path)) files[name] = await readFile(path, 'utf8')
    }
    // Identifiants des registries : hors du dossier de l'environnement.
    const dockerConfig = options.env.DOCKER_CONFIG && join(options.env.DOCKER_CONFIG, 'config.json')
    if (dockerConfig && existsSync(dockerConfig)) {
      files['.docker/config.json'] = await readFile(dockerConfig, 'utf8')
    }
    this.calls.push({ args, env: options.env, cwd: options.cwd, files })
    const legacy = Object.entries(this.legacy).find(([name]) =>
      args.includes(`label=com.docker.compose.project=${name}`),
    )?.[1]
    if (legacy && args[0] === 'ps') {
      for (const id of legacy.running) options.onLine(id, 'stdout')
    }
    if (legacy && args[0] === 'network' && args[1] === 'ls') {
      for (const id of legacy.networks) options.onLine(id, 'stdout')
    }
    if (args[0] === 'ps' && this.portTaken && args.includes(`publish=${this.portTaken.port}`)) {
      options.onLine(this.portTaken.by, 'stdout')
    }
    if (args.includes('up') && this.portTaken) {
      options.onLine(
        `Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint site-prod-back-1 (1a97): Bind for 0.0.0.0:${this.portTaken.port} failed: port is already allocated`,
        'stderr',
      )
      return { code: 1 }
    }
    if (args.includes('up')) {
      options.onLine(`Container démarré avec DB_PASSWORD=${options.env.DB_PASSWORD}`, 'stdout')
      if (this.failUp) {
        options.onLine('container site-prod-back-1 is unhealthy', 'stderr')
        return { code: 1 }
      }
    }
    return { code: 0 }
  }
  composeCalls() {
    return this.calls
      .filter((call) => call.args[0] === 'compose')
      .map((call) => call.args[call.args.indexOf('compose.vercio.yml') + 1] ?? call.args.at(-1))
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Déploiements', () => {
  const docker = new FakeDocker()
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  let registry: Awaited<ReturnType<typeof startFakeImageRegistry>>
  let cookie: string
  let project: ProjectView
  const images: Record<string, string> = {}

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  const prod = () => project.environments[0]!

  async function deploy(): Promise<DeploymentSummary> {
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${prod().id}/deployments`,
    )
    expect(response.statusCode).toBe(202)
    await app.deployments.idle()
    return response.json()
  }

  async function detail(id: string): Promise<DeploymentDetail> {
    return (await call('GET', `/deployments/${id}`)).json()
  }

  async function setVersion(ref: string) {
    await call('PUT', `/projects/${project.id}/environments/${prod().id}`, {
      name: 'Production',
      sources: [
        {
          source: project.sources[0]!.id,
          branch: 'main',
          ref,
          mode: ref === 'latest' ? 'tracking' : 'locked',
        },
      ],
    })
  }

  beforeAll(async () => {
    // Dossier de données relatif, comme `VERCIO_DATA_DIR=./data` en développement.
    const dataDir = relative(process.cwd(), join(tmpdir(), `vercio-deploy-${process.pid}`))
    ;({ app, db, close } = await setupTestApp({ VERCIO_DATA_DIR: dataDir }, docker))
    const [user] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'a',
        username: 'alice',
        displayName: 'Alice',
        roles: ['vercio-admin'],
      })
      .returning()
    cookie = `__Host-vercio_session=${(await new SessionStore(db, 3_600_000).create(user!.id, {})).token}`
    gitlab = await startFakeGitLab()
    for (const tag of ['latest', 'v1.2', 'v1.3']) {
      images[`acme/site/front:${tag}`] = '2026-02-01T00:00:00Z'
      images[`acme/site/back:${tag}`] = '2026-02-01T00:00:00Z'
    }
    registry = await startFakeImageRegistry(images)
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
        password: 'registry-pass',
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
        environments: [
          { name: 'Production', slug: 'prod', sources: [{ source: 's', branch: 'main' }] },
        ],
      })
    ).json()
    await call('PUT', `/projects/${project.id}/variables`, {
      variables: [
        { key: 'NODE_ENV', value: 'production', secret: false },
        { key: 'DB_PASSWORD', value: 'mot-de-passe-secret', secret: true },
        { key: 'LD_PRELOAD', value: '/var/lib/vercio/envs/x.so', secret: false },
        { key: 'PATH', value: '/tmp/piege', secret: false },
      ],
    })
    await addWatchChannel(db)
  })

  beforeEach(async () => {
    docker.calls = []
    docker.failUp = false
    docker.portTaken = null
    docker.legacy = {}
    await db.delete(notificationDeliveries)
  })

  const notified = () => queuedNotifications(db)

  afterAll(async () => {
    await gitlab?.close()
    await registry?.close()
    await close?.()
  })

  it('déploie latest : images épinglées par digest, variables injectées, secrets masqués', async () => {
    const deployment = await deploy()
    const result = await detail(deployment.id)
    expect(result.status).toBe('succeeded')
    expect(result.username).toBe('alice')
    const [message, ...others] = await notified()
    expect(others).toHaveLength(0)
    expect(message).toMatchObject({
      event: 'deployment.succeeded',
      severity: 'success',
      url: `${ORIGIN}/projets/site/deploiements/${deployment.id}`,
      project: { slug: 'site' },
      environment: { slug: 'prod' },
    })
    expect(message!.facts).toContainEqual({ label: 'Déclencheur', value: expect.any(String) })
    expect(result.versions[project.sources[0]!.id]).toEqual({
      branch: 'main',
      ref: 'latest',
      tag: 'latest',
    })
    expect(result.images.front).toMatch(
      new RegExp(`^${registry.url.replace('http://', '')}/acme/site/front@sha256:`),
    )

    expect(docker.composeCalls()).toEqual(['config', 'pull', 'up'])
    const up = docker.calls.find((c) => c.args.includes('up'))!
    expect(up.args).toEqual(
      expect.arrayContaining(['--project-name', 'vercio_site_prod', '--wait', '--remove-orphans']),
    )
    expect(up.cwd.endsWith(join('envs', 'site', 'prod'))).toBe(true)
    // Docker est lancé depuis ce dossier : ses chemins doivent être absolus, sinon il ne trouve
    // ni les identifiants ni le plugin Compose (« unknown flag: --ansi »).
    expect(isAbsolute(up.cwd)).toBe(true)
    expect(isAbsolute(up.env.DOCKER_CONFIG!)).toBe(true)
    // Jamais dans le dossier de l'environnement, que des conteneurs peuvent monter.
    expect(up.env.DOCKER_CONFIG!.startsWith(up.cwd)).toBe(false)
    expect(isAbsolute(up.env.HOME!)).toBe(true)

    const override = parse(up.files['compose.vercio.yml']!)
    expect(override.services.front.image).toBe(result.images.front)
    // Politique par défaut de l'environnement : unless-stopped.
    expect(override.services.front.restart).toBe('unless-stopped')
    expect(override.services.redis.restart).toBe('unless-stopped')
    expect(override.services.redis.labels['vercio.deployment']).toBe(deployment.id)
    expect(up.files['compose.yml']).toContain('redis:7')

    // Identifiants du registry fournis à Docker pendant le déploiement, puis effacés du disque.
    const auth = JSON.parse(up.files['.docker/config.json']!).auths[
      registry.url.replace('http://', '')
    ].auth
    expect(Buffer.from(auth, 'base64').toString()).toBe('ci:registry-pass')
    expect(existsSync(up.env.DOCKER_CONFIG!)).toBe(false)

    // `env_file: .env` du Compose : fichier écrit avec les variables, puis supprimé.
    expect(up.files['.env']).toContain("DB_PASSWORD='mot-de-passe-secret'")
    expect(existsSync(join(up.cwd, '.env'))).toBe(false)

    // Variables du projet transmises, sans écraser PATH ni exposer la configuration de Vercio.
    expect(up.env).toMatchObject({ NODE_ENV: 'production', DB_PASSWORD: 'mot-de-passe-secret' })
    // Transmise aux conteneurs (env_file), jamais au programme docker de Vercio.
    expect(up.env.LD_PRELOAD).toBeUndefined()
    expect(up.files['.env']).toContain('LD_PRELOAD=')
    expect(up.env.PATH).not.toBe('/tmp/piege')
    expect(up.env.VERCIO_SECRET_KEY).toBeUndefined()
    expect(up.env.DATABASE_URL).toBeUndefined()

    const text = result.logs.map((log) => log.line).join('\n')
    expect(text).toContain('Container démarré avec DB_PASSWORD=••••••')
    expect(text).not.toContain('mot-de-passe-secret')
    expect(text).toContain('Variable PATH réservée à Vercio')
    expect(text).toContain('✔ Déploiement réussi')
  })

  it('déploie un tag précis et nettoie les anciennes images', async () => {
    await setVersion('v1.2')
    const deployment = await deploy()
    const result = await detail(deployment.id)
    expect(result.status).toBe('succeeded')
    expect(Object.values(result.versions)[0]).toMatchObject({ ref: 'v1.2', tag: 'v1.2' })
    expect(docker.calls.some((c) => c.args[0] === 'image' && c.args[1] === 'ls')).toBe(true)
    // Version précédente → nouvelle version, par source.
    const [message] = await notified()
    expect(message!.facts).toContainEqual({ label: expect.any(String), value: 'latest → v1.2' })
  })

  it('refuse de déployer une image absente, sans toucher aux conteneurs', async () => {
    await setVersion('v9.9')
    const deployment = await deploy()
    const result = await detail(deployment.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      `Image back introuvable : ${registry.url.replace('http://', '')}/acme/site/back:v9.9`,
    )
    // Diagnostic : le dépôt d'images existe, c'est le tag qui manque.
    expect(result.error).toContain(
      'Le tag « v9.9 » n’existe pas ; tags présents : v1.3, v1.2, latest',
    )
    expect(docker.calls).toHaveLength(0)
    const [message] = await notified()
    expect(message).toMatchObject({ event: 'deployment.failed', severity: 'critical' })
    expect(message!.summary).toContain('n’a pas été modifié : il tourne toujours sur')
    expect(message!.details).toContain('Image back introuvable')
  })

  it('signale un chemin d’image faux', async () => {
    const [service] = await db
      .update(trackedServices)
      .set({ imageRepository: 'acme/site/inexistant' })
      .where(eq(trackedServices.serviceName, 'back'))
      .returning()
    await setVersion('latest')
    const result = await detail((await deploy()).id)
    await db
      .update(trackedServices)
      .set({ imageRepository: 'acme/site/back' })
      .where(eq(trackedServices.id, service!.id))
    expect(result.error).toContain('Aucune image à ce chemin dans le registry « Registry »')
    expect(docker.calls).toHaveLength(0)
  })

  it('revient automatiquement à la dernière version saine si le démarrage échoue', async () => {
    await setVersion('v1.3')
    docker.failUp = true
    const failed = await deploy()
    // Le second « up » (retour) échoue aussi : le déploiement reste en échec.
    const result = await detail(failed.id)
    expect(result.status).toBe('failed')
    expect(result.logs.map((log) => log.line).join('\n')).toContain('Retour automatique')
    const history: DeploymentSummary[] = (
      await call('GET', `/projects/${project.id}/environments/${prod().id}/deployments`)
    ).json()
    expect(history[0]).toMatchObject({ trigger: 'auto_rollback', status: 'failed' })
    // FakeDocker échoue encore au second « up » : le retour est lui aussi en échec,
    // et il n'y a pas de boucle de retours.
    expect(history.filter((d) => d.trigger === 'auto_rollback')).toHaveLength(1)
    // Un seul message pour l'échec et le retour raté, lié au déploiement fautif.
    const messages = await notified()
    expect(messages.map((m) => m.event)).toEqual(['deployment.rollback_failed'])
    expect(messages[0]!.url).toContain(failed.id)
    expect(messages[0]!.data).toMatchObject({ rollbackDeploymentId: history[0]!.id })
  })

  it('retour automatique réussi', async () => {
    let ups = 0
    const original = docker.run.bind(docker)
    docker.run = async (command, args, options) => {
      if (args.includes('up') && ups++ === 0) {
        docker.calls.push({ args, env: options.env, cwd: options.cwd, files: {} })
        return { code: 1 }
      }
      return original(command, args, options)
    }
    try {
      const failed = await deploy()
      const history: DeploymentSummary[] = (
        await call('GET', `/projects/${project.id}/environments/${prod().id}/deployments`)
      ).json()
      const failedDetail = await detail(failed.id)
      expect(failedDetail.status).toBe('rolled_back')
      expect(history[0]).toMatchObject({ trigger: 'auto_rollback', status: 'succeeded' })
      expect(failedDetail.autoRollbackId).toBe(history[0]!.id)
      // Le retour est annoncé dans le journal du déploiement échoué.
      expect(failedDetail.logs.map((l) => l.line).join('\n')).toContain(
        `(déploiement ${history[0]!.id})`,
      )
      expect(Object.values(history[0]!.versions)[0]).toMatchObject({ tag: 'v1.2' })
      const view: ProjectView = (await call('GET', '/projects/site')).json()
      expect(view.environments[0]!.current?.id).toBe(history[0]!.id)
      // Ni « échec » ni « réussite » du retour : un seul message « version précédente rétablie ».
      const messages = await notified()
      expect(messages.map((m) => m.event)).toEqual(['deployment.rolled_back'])
      expect(messages[0]!.summary).toContain('v1.2')
    } finally {
      docker.run = original
    }
  })

  it('revient manuellement à un déploiement réussi', async () => {
    const history: DeploymentSummary[] = (
      await call('GET', `/projects/${project.id}/environments/${prod().id}/deployments`)
    ).json()
    const first = history.at(-1)!
    expect(first.status).toBe('succeeded')
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${prod().id}/deployments/${first.id}/rollback`,
    )
    expect(response.statusCode).toBe(202)
    await app.deployments.idle()
    const rollback = await detail(response.json().id)
    expect(rollback).toMatchObject({
      trigger: 'rollback',
      status: 'succeeded',
      rollbackOfId: first.id,
    })
    expect(rollback.images).toEqual(first.images)
    // L'environnement est verrouillé sur la version rétablie.
    const view: ProjectView = (await call('GET', '/projects/site')).json()
    expect(view.environments[0]!.sources[0]).toMatchObject({ ref: 'latest', mode: 'locked' })

    const failed = history.find((d) => d.status === 'failed')!
    const refused = await call(
      'POST',
      `/projects/${project.id}/environments/${prod().id}/deployments/${failed.id}/rollback`,
    )
    expect(refused.statusCode).toBe(400)
  })

  it('diffuse le journal en direct (SSE) jusqu’à la fin', async () => {
    await setVersion('latest')
    const response = await call(
      'POST',
      `/projects/${project.id}/environments/${prod().id}/deployments`,
    )
    const id = response.json().id
    const stream = await app.inject({
      method: 'GET',
      url: `/api/deployments/${id}/events`,
      headers: { cookie },
    })
    expect(stream.headers['content-type']).toContain('text/event-stream')
    const events = stream.body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)))
    expect(
      events.some((e) => e.type === 'log' && e.log.line.includes('Démarrage des conteneurs')),
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'status', deployment: { status: 'succeeded' } })
  })

  it('déploie le dernier build selon la convention de tags du dépôt', async () => {
    // Tag fixe « v1.3 » comme dernier build (modèle sans {branch}).
    await db.update(appSources).set({ latestTagTemplate: 'v1.3' })
    await setVersion('latest')
    const result = await detail((await deploy()).id)
    await db.update(appSources).set({ latestTagTemplate: null })
    expect(result.status).toBe('succeeded')
    expect(Object.values(result.versions)[0]).toMatchObject({ ref: 'latest', tag: 'v1.3' })
  })

  it('explique un port déjà pris et nomme le conteneur qui l’occupe', async () => {
    docker.portTaken = { port: '14432', by: 'budgie-db-1' }
    const failed = await deploy()
    const result = await detail(failed.id)
    expect(result.error).toBe(
      'Démarrage des conteneurs (120 s max) : le port 14432 de l’hôte est déjà pris par le conteneur « budgie-db-1 » : arrêtez-le ou changez le port publié dans le fichier Compose',
    )
    // Aucun healthcheck dans le fichier Compose : l'étape n'en parle pas.
    expect(result.logs.map((log) => log.line)).toContain('▶ Démarrage des conteneurs (120 s max)')
  })

  it('reprend un projet lancé hors de Vercio : volumes réutilisés, ancien projet remplacé', async () => {
    docker.legacy = { 'site-legacy': { running: ['old-front', 'old-back'], networks: ['net1'] } }
    const created = await call('POST', `/projects/${project.id}/environments`, {
      name: 'Reprise',
      slug: 'reprise',
      sources: [{ source: project.sources[0]!.id, branch: 'main' }],
      migration: { composeProject: 'site-legacy', volumes: { data: 'site-legacy_data' } },
    })
    expect(created.statusCode).toBe(201)
    const env = (created.json() as ProjectView).environments.find((e) => e.slug === 'reprise')!
    expect(env.migratingFrom).toBe('site-legacy')

    docker.calls = []
    await call('POST', `/projects/${project.id}/environments/${env.id}/deployments`)
    await app.deployments.idle()
    const args = docker.calls.map((c) => c.args)
    const index = (predicate: (a: string[]) => boolean) => args.findIndex(predicate)
    const stop = index((a) => a[0] === 'stop')
    const up = index((a) => a.includes('up'))
    const rm = index((a) => a[0] === 'rm')
    expect(args[stop]).toEqual(['stop', 'old-front', 'old-back'])
    // Arrêt avant le démarrage (ports libérés), suppression après la réussite.
    expect(stop).toBeLessThan(up)
    expect(rm).toBeGreaterThan(up)
    expect(args[rm]).toEqual(['rm', '-f', 'old-front', 'old-back'])
    expect(args).toContainEqual(['network', 'rm', 'net1'])
    // Volume du projet d'origine réutilisé, sans copie.
    const override = parse(docker.calls[up]!.files['compose.vercio.yml']!)
    expect(override.volumes).toEqual({ data: { name: 'site-legacy_data', external: true } })
    const view: ProjectView = (await call('GET', '/projects/site')).json()
    expect(view.environments.find((e) => e.slug === 'reprise')!.migratingFrom).toBeNull()

    // Échec du premier déploiement d'une reprise : l'ancien projet est relancé.
    docker.legacy = { 'blog-legacy': { running: ['blog-1'], networks: [] } }
    const second = await call('POST', `/projects/${project.id}/environments`, {
      name: 'Blog',
      slug: 'blog',
      sources: [{ source: project.sources[0]!.id, branch: 'main' }],
      migration: { composeProject: 'blog-legacy' },
    })
    const blog = (second.json() as ProjectView).environments.find((e) => e.slug === 'blog')!
    docker.calls = []
    docker.failUp = true
    await call('POST', `/projects/${project.id}/environments/${blog.id}/deployments`)
    await app.deployments.idle()
    const calls = docker.calls.map((c) => c.args)
    expect(calls).toContainEqual(['start', 'blog-1'])
    expect(calls.some((a) => a[0] === 'rm')).toBe(false)
    const after: ProjectView = (await call('GET', '/projects/site')).json()
    expect(after.environments.find((e) => e.slug === 'blog')!.migratingFrom).toBe('blog-legacy')
    docker.legacy = {}
    for (const slug of ['reprise', 'blog']) {
      const id = after.environments.find((e) => e.slug === slug)!.id
      await call('DELETE', `/projects/${project.id}/environments/${id}`)
    }
  })

  it('arrête les conteneurs quand on supprime l’environnement', async () => {
    expect(
      (await call('DELETE', `/projects/${project.id}/environments/${prod().id}`)).statusCode,
    ).toBe(204)
    const down = docker.calls.find((c) => c.args.includes('down'))
    expect(down?.args).toEqual(
      expect.arrayContaining(['--project-name', 'vercio_site_prod', 'down']),
    )
  })
})

describe.skipIf(!TEST_DATABASE_URL)('Historique des déploiements', () => {
  it('ne garde que les N derniers déploiements par environnement', async () => {
    const { DeploymentEngine } = await import('../src/deploy/engine.js')
    const { app, db, close } = await setupTestApp({}, { run: async () => ({ code: 0 }) })
    try {
      const { hosts, projects, environments, deployments } = await import('../src/db/schema.js')
      const [host] = await db.select().from(hosts).limit(1)
      const [project] = await db
        .insert(projects)
        .values({ name: 'P', slug: 'p', composeInline: 'services:\n  a:\n    image: alpine\n' })
        .returning()
      const [env] = await db
        .insert(environments)
        .values({ projectId: project!.id, hostId: host!.id, name: 'E', slug: 'e' })
        .returning()
      for (let i = 0; i < 5; i++) {
        await db
          .insert(deployments)
          .values({ environmentId: env!.id, trigger: 'user', status: 'succeeded' })
      }
      const engine = new DeploymentEngine(
        db,
        { encrypt: (v: string) => v, decrypt: (v: string) => v } as never,
        {
          dataDir: '/tmp',
          dockerSocket: '/var/run/docker.sock',
          runner: { run: async () => ({ code: 0 }) },
          log: app.log,
          keepDeployments: 3,
        },
      )
      await (engine as unknown as { pruneHistory(id: string): Promise<void> }).pruneHistory(env!.id)
      expect(await db.select().from(deployments)).toHaveLength(3)
    } finally {
      await close()
    }
  })
})
