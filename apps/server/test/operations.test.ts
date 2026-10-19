import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ContainerView, ProjectView, WebhookConfigView } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { CommandRunner } from '../src/deploy/command.js'
import type { Database } from '../src/db/client.js'
import { notificationDeliveries, users } from '../src/db/schema.js'
import { GITLAB_TOKEN, startFakeGitLab, startFakeImageRegistry } from './fake-services.js'
import {
  addWatchChannel,
  FakeHost,
  ORIGIN,
  queuedNotifications,
  setupTestApp,
  TEST_DATABASE_URL,
  type FakeContainer,
} from './helpers.js'

/** Docker simulé : `compose up` peut être retenu pour garder un déploiement en cours. */
class GatedDocker implements CommandRunner {
  ups = 0
  #gate: Promise<void> | null = null
  #release: (() => void) | null = null
  hold() {
    this.#gate = new Promise((resolve) => (this.#release = resolve))
  }
  release() {
    this.#release?.()
    this.#gate = null
  }
  async run(_command: string, args: string[]) {
    if (args.includes('up')) {
      this.ups++
      await this.#gate
    }
    return { code: 0 }
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Webhooks et conteneurs', () => {
  const docker = new GatedDocker()
  const host = new FakeHost()
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  let gitlab: Awaited<ReturnType<typeof startFakeGitLab>>
  let registry: Awaited<ReturnType<typeof startFakeImageRegistry>>
  let admin: string
  let viewer: string
  let project: ProjectView
  const images: Record<string, string> = {}

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
    cookie: string = admin,
  ) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    })

  const prod = () => project.environments[0]!
  const envUrl = () => `/projects/${project.id}/environments/${prod().id}`
  const config = async (cookie = admin): Promise<WebhookConfigView> =>
    (await call('GET', `${envUrl()}/webhooks`, undefined, cookie)).json()

  /** Appel de webhook tel qu'il arrive du reverse proxy amont. */
  const hook = (
    path: string,
    options: { body?: string; headers?: Record<string, string>; ip?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/hooks/${path}`,
      remoteAddress: '127.0.0.1',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': options.ip ?? '203.0.113.10',
        ...options.headers,
      },
      ...(options.body !== undefined ? { payload: options.body } : {}),
    })

  async function setRef(ref: string, mode: 'tracking' | 'locked', branch = 'main') {
    await call('PUT', envUrl(), {
      name: 'Production',
      sources: [{ source: project.sources[0]!.id, branch, ref, mode }],
    })
  }

  /** Nouveau build de `latest` : même tag, nouveau digest. */
  function rebuildLatest(date: string) {
    images['acme/site/front:latest'] = date
  }

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp({}, docker, host))
    const store = new SessionStore(db, 3_600_000)
    const session = async (username: string, roles: string[]) => {
      const [user] = await db
        .insert(users)
        .values({ provider: 'oidc', subject: username, username, displayName: username, roles })
        .returning()
      return `__Host-vercio_session=${(await store.create(user!.id, {})).token}`
    }
    admin = await session('alice', ['vercio-admin'])
    viewer = await session('carol', ['vercio-viewer'])
    gitlab = await startFakeGitLab()
    for (const tag of ['latest', 'v1.3']) images[`acme/site/front:${tag}`] = '2026-02-01T00:00:00Z'
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
        ],
        environments: [
          { name: 'Production', slug: 'prod', sources: [{ source: 's', branch: 'main' }] },
        ],
      })
    ).json()
    await call('PUT', `/projects/${project.id}/variables`, {
      variables: [{ key: 'DB_PASSWORD', value: 'mot-de-passe-secret', secret: true }],
    })
    await addWatchChannel(db, ['webhook.rejected', 'webhook.ignored', 'deployment.failed'])
  })

  beforeEach(async () => {
    await app.deployments.idle()
    await setRef('latest', 'tracking')
    await call('PUT', `${envUrl()}/webhooks`, { ipAllowlist: [] })
    await call('PUT', '/settings/webhooks', { ipAllowlist: [] })
    await db.delete(notificationDeliveries)
  })

  afterAll(async () => {
    docker.release()
    await gitlab?.close()
    await registry?.close()
    await close?.()
  })

  describe('Webhooks', () => {
    it('crée un jeton et un secret par environnement, visibles des seuls deployers', async () => {
      const view = await config()
      const source = view.sources[0]!
      expect(source.token).toMatch(/^[\w-]{40,}$/)
      expect(source.secret).toBeTruthy()
      expect(source.urls?.gitlab).toBe(`${ORIGIN}/api/hooks/gitlab/${source.token}`)

      const forViewer = await config(viewer)
      expect(forViewer.sources[0]).toMatchObject({ token: null, secret: null, urls: null })
    })

    it('refuse un jeton inconnu', async () => {
      const response = await hook('jeton-inconnu-de-vercio')
      expect(response.statusCode).toBe(404)
    })

    it('webhook générique : déploie si latest a changé, sinon ne fait rien', async () => {
      const { token } = (await config()).sources[0]!
      const first = await hook(token!, { body: '' })
      expect(first.statusCode).toBe(202)
      expect(first.json()).toMatchObject({ result: 'deployed' })
      await app.deployments.idle()

      const again = await hook(token!, { body: JSON.stringify({ branch: 'main' }) })
      expect(again.json()).toMatchObject({ result: 'unchanged', deploymentId: null })

      rebuildLatest('2026-03-01T00:00:00Z')
      const rebuilt = await hook(token!)
      expect(rebuilt.json()).toMatchObject({ result: 'deployed' })
      await app.deployments.idle()
      const deployment = (await call('GET', `/deployments/${rebuilt.json().deploymentId}`)).json()
      expect(deployment).toMatchObject({ trigger: 'webhook', status: 'succeeded' })
    })

    it('ignore une autre branche et un environnement verrouillé', async () => {
      const { token } = (await config()).sources[0]!
      const other = await hook(token!, { body: JSON.stringify({ branch: 'develop' }) })
      expect(other.json()).toMatchObject({ result: 'ignored' })
      expect(other.json().message).toContain('develop')

      await setRef('v1.3', 'locked')
      rebuildLatest('2026-04-01T00:00:00Z')
      const locked = await hook(token!)
      expect(locked.json()).toMatchObject({ result: 'ignored', deploymentId: null })
      expect(locked.json().message).toBe('Environnement verrouillé sur v1.3')
      // Seul le build ignoré à cause du verrou est signalé (pas l'autre branche).
      const messages = await queuedNotifications(db)
      expect(messages.map((m) => m.event)).toEqual(['webhook.ignored'])
      expect(messages[0]!.summary).toContain('verrouillé sur v1.3')
      expect(messages[0]!.url).toBe(`${ORIGIN}/projets/site?onglet=webhooks&env=prod`)
    })

    it('rattache l’appel au déploiement déjà en attente', async () => {
      const { token } = (await config()).sources[0]!
      docker.hold()
      await call('POST', `${envUrl()}/deployments`)
      const queued = (await call('POST', `${envUrl()}/deployments`)).json()
      const response = await hook(token!)
      expect(response.json()).toMatchObject({ result: 'merged', deploymentId: queued.id })
      docker.release()
      await app.deployments.idle()
    })

    it('filtre par IP : liste de l’environnement, sinon liste globale', async () => {
      const { token } = (await config()).sources[0]!
      await call('PUT', '/settings/webhooks', { ipAllowlist: ['10.0.0.0/8'] })
      const refused = await hook(token!, { ip: '203.0.113.10' })
      expect(refused.statusCode).toBe(403)
      expect(refused.json().message).toContain('203.0.113.10')
      expect((await hook(token!, { ip: '10.1.2.3' })).statusCode).toBeLessThan(300)

      // La liste de l'environnement remplace la liste globale.
      const updated = await call('PUT', `${envUrl()}/webhooks`, {
        ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'],
      })
      expect(updated.json().ipAllowlist).toEqual(['203.0.113.0/24', '2001:db8::/32'])
      expect((await hook(token!, { ip: '203.0.113.10' })).statusCode).toBeLessThan(300)
      expect((await hook(token!, { ip: '10.1.2.3' })).statusCode).toBe(403)
      // Deux refus : un seul message, la répétition est comptée.
      const messages = await queuedNotifications(db)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ event: 'webhook.rejected', suppressedCount: 1 })
      expect(messages[0]!.facts).toContainEqual({ label: 'Adresse IP', value: '203.0.113.10' })
    })

    it('ne se laisse pas tromper par un X-Forwarded-For forgé', async () => {
      const { token } = (await config()).sources[0]!
      await call('PUT', `${envUrl()}/webhooks`, { ipAllowlist: ['10.0.0.0/8'] })
      // Le client ajoute une fausse adresse ; le proxy amont ajoute la vraie à la fin.
      const response = await hook(token!, { ip: '10.0.0.1, 198.51.100.7' })
      expect(response.statusCode).toBe(403)
      expect(response.json().message).toContain('198.51.100.7')
    })

    it('désactivés : toutes les URL répondent 404, la liste d’IP est gardée', async () => {
      const { token } = (await config()).sources[0]!
      await call('PUT', '/settings/webhooks', { ipAllowlist: ['10.0.0.0/8'] })
      const off = await call('PUT', '/settings/webhooks', { enabled: false })
      expect(off.json()).toEqual({ enabled: false, ipAllowlist: ['10.0.0.0/8'] })
      expect((await config()).enabled).toBe(false)
      const before = (await config()).events.length
      for (const path of [token!, `gitlab/${token}`, `github/${token}`]) {
        const response = await hook(path, { ip: '10.1.2.3' })
        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual({ error: 'Route inconnue' })
      }
      // Rien n'est journalisé ni déployé.
      expect((await config()).events).toHaveLength(before)
      await call('PUT', '/settings/webhooks', { enabled: true, ipAllowlist: [] })
      expect((await hook(token!)).statusCode).toBeLessThan(300)
    })

    it('valide la liste d’IP saisie', async () => {
      const response = await call('PUT', `${envUrl()}/webhooks`, { ipAllowlist: ['10.0.0.300'] })
      expect(response.statusCode).toBe(400)
      expect((await call('PUT', '/settings/webhooks', { ipAllowlist: ['x'] })).statusCode).toBe(400)
    })

    it('GitLab : vérifie X-Gitlab-Token et ne réagit qu’aux pipelines réussis', async () => {
      const { token, secret } = (await config()).sources[0]!
      const pipeline = (status: string, ref = 'main', tag = false) =>
        JSON.stringify({ object_kind: 'pipeline', object_attributes: { id: 42, ref, tag, status } })
      const gitlabHook = (body: string, headers: Record<string, string> = {}) =>
        hook(`gitlab/${token}`, {
          body,
          headers: { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-token': secret!, ...headers },
        })

      expect((await gitlabHook(pipeline('success'), { 'x-gitlab-token': 'faux' })).statusCode).toBe(
        401,
      )
      const running = await gitlabHook(pipeline('running'))
      expect(running.json()).toMatchObject({ result: 'ignored' })

      rebuildLatest('2026-05-01T00:00:00Z')
      const success = await gitlabHook(pipeline('success'))
      expect(success.json()).toMatchObject({ result: 'deployed' })
      await app.deployments.idle()

      // Pipeline de tag : pas de branche, le registry est relu quand même.
      const tagPipeline = await gitlabHook(pipeline('success', 'v1.4', true))
      expect(tagPipeline.json()).toMatchObject({ result: 'unchanged' })

      const tagPush = await gitlabHook(
        JSON.stringify({ object_kind: 'tag_push', ref: 'refs/tags/v1.4' }),
        { 'x-gitlab-event': 'Tag Push Hook' },
      )
      expect(tagPush.json()).toMatchObject({ result: 'ignored' })
      expect(tagPush.json().message).toContain('Nouveau tag')
    })

    it('GitHub : vérifie la signature et réagit aux workflows réussis', async () => {
      const { token, secret } = (await config()).sources[0]!
      const githubHook = (event: string, payload: object, signWith = secret!) => {
        const body = JSON.stringify(payload)
        const signature = `sha256=${createHmac('sha256', signWith).update(body).digest('hex')}`
        return hook(`github/${token}`, {
          body,
          headers: { 'x-github-event': event, 'x-hub-signature-256': signature },
        })
      }
      const run = (head_branch: string, conclusion = 'success') => ({
        action: 'completed',
        workflow_run: { name: 'build', head_branch, conclusion },
      })

      expect((await githubHook('workflow_run', run('main'), 'mauvais-secret')).statusCode).toBe(401)
      expect((await githubHook('ping', { zen: 'Keep it simple' })).json()).toMatchObject({
        result: 'ignored',
      })
      expect((await githubHook('workflow_run', run('main', 'failure'))).json()).toMatchObject({
        result: 'ignored',
      })
      expect((await githubHook('workflow_run', run('feature/x'))).json()).toMatchObject({
        result: 'ignored',
      })

      rebuildLatest('2026-06-01T00:00:00Z')
      // Un workflow lancé par un tag de version compte comme un build de la branche.
      const tagged = await githubHook('workflow_run', run('v1.5'))
      expect(tagged.json()).toMatchObject({ result: 'deployed' })
      await app.deployments.idle()
      const published = await githubHook('package', {
        action: 'published',
        package: { name: 'front', package_version: { name: 'latest' } },
      })
      expect(published.json()).toMatchObject({ result: 'unchanged' })
    })

    it('refuse un corps invalide', async () => {
      const { token, secret } = (await config()).sources[0]!
      const response = await hook(`gitlab/${token}`, {
        body: '{pas du json',
        headers: { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-token': secret! },
      })
      expect(response.statusCode).toBe(400)
    })

    it('refuse l’URL générique d’un dépôt qui envoie des webhooks signés', async () => {
      // Le dépôt a déjà envoyé des webhooks GitLab signés (tests précédents).
      const { token } = (await config()).sources[0]!
      const response = await hook(token!)
      expect(response.statusCode).toBe(403)
      expect(response.json().message).toContain('URL générique est refusée')
    })

    it('régénère le jeton : l’ancienne URL ne fonctionne plus', async () => {
      const before = (await config()).sources[0]!
      const response = await call('POST', `${envUrl()}/webhooks/${before.appSourceId}/regenerate`)
      const after = (response.json() as WebhookConfigView).sources[0]!
      expect(after.token).not.toBe(before.token)
      expect(after.secret).not.toBe(before.secret)
      expect((await hook(before.token!)).statusCode).toBe(404)
      // Nouveau jeton reconnu (l'URL générique reste refusée pour ce dépôt signé).
      expect((await hook(after.token!)).statusCode).toBe(403)
      // Un lecteur ne peut pas régénérer.
      const denied = await call(
        'POST',
        `${envUrl()}/webhooks/${before.appSourceId}/regenerate`,
        undefined,
        viewer,
      )
      expect(denied.statusCode).toBe(403)
    })

    it('garde l’historique des appels', async () => {
      const { events } = await config()
      const results = new Set(events.map((event) => event.result))
      for (const result of ['deployed', 'unchanged', 'ignored', 'merged', 'rejected']) {
        expect(results).toContain(result)
      }
      const gitlabEvent = events.find(
        (event) => event.kind === 'gitlab' && event.result === 'deployed',
      )
      expect(gitlabEvent?.details).toMatchObject({
        event: 'pipeline',
        ref: 'main',
        status: 'success',
      })
      expect(events[0]!.ip).toBeTruthy()
    })
  })

  describe('Conteneurs', () => {
    const containers: FakeContainer[] = [
      {
        id: 'c-back',
        name: 'vercio_site_prod-back-1',
        service: 'back',
        image: 'back',
        state: 'running',
        status: 'Up 2 minutes (healthy)',
        health: 'healthy',
        createdAt: '2026-01-01T00:00:00.000Z',
        ports: [],
      },
      {
        id: 'c-front',
        name: 'vercio_site_prod-front-1',
        service: 'front',
        image: 'front',
        state: 'running',
        status: 'Up 2 minutes',
        health: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        ports: ['8080→80/tcp'],
      },
    ]

    beforeEach(() => {
      host.containers.set('vercio_site_prod', structuredClone(containers))
      host.containers.set('vercio_autre_prod', [{ ...containers[0]!, id: 'c-autre' }])
      host.actions = []
    })

    it('liste les conteneurs de l’environnement', async () => {
      const response = await call('GET', `${envUrl()}/containers`, undefined, viewer)
      expect(response.statusCode).toBe(200)
      expect(response.json().map((c: ContainerView) => c.id)).toEqual(['c-back', 'c-front'])
    })

    it('arrête un service, redémarre tout l’environnement', async () => {
      const stopped = await call('POST', `${envUrl()}/containers/actions`, {
        action: 'stop',
        service: 'front',
      })
      expect(stopped.statusCode).toBe(200)
      expect(host.actions).toEqual([{ id: 'c-front', action: 'stop' }])
      expect(stopped.json().find((c: ContainerView) => c.id === 'c-front').state).toBe('exited')

      // Le relais d'un service mis à jour sans coupure suit le service.
      host.containers.get('vercio_site_prod')!.push({
        ...host.containers.get('vercio_site_prod')![0]!,
        id: 'c-relay',
        name: 'vercio_site_prod-vercio-relay-front-1',
        service: 'vercio-relay-front',
        relayFor: 'front',
      })
      host.actions = []
      await call('POST', `${envUrl()}/containers/actions`, { action: 'start', service: 'front' })
      expect(host.actions.map((a) => a.id).sort()).toEqual(['c-front', 'c-relay'])
      host.containers.set(
        'vercio_site_prod',
        host.containers.get('vercio_site_prod')!.filter((c) => c.id !== 'c-relay'),
      )

      host.actions = []
      await call('POST', `${envUrl()}/containers/actions`, { action: 'restart' })
      // Les conteneurs des autres projets ne sont jamais touchés.
      expect(host.actions.map((a) => a.id).sort()).toEqual(['c-back', 'c-front'])
    })

    it('refuse un service inconnu, un lecteur, et pendant un déploiement', async () => {
      const unknown = await call('POST', `${envUrl()}/containers/actions`, {
        action: 'stop',
        service: 'redis',
      })
      expect(unknown.statusCode).toBe(404)
      const denied = await call(
        'POST',
        `${envUrl()}/containers/actions`,
        { action: 'stop' },
        viewer,
      )
      expect(denied.statusCode).toBe(403)

      docker.hold()
      await call('POST', `${envUrl()}/deployments`)
      const busy = await call('POST', `${envUrl()}/containers/actions`, { action: 'stop' })
      expect(busy.statusCode).toBe(409)
      docker.release()
      await app.deployments.idle()
      expect(host.actions).toEqual([])
    })

    it('diffuse les logs, filtrés par service, secrets masqués', async () => {
      host.logs.set('c-back', [
        { stream: 'stdout', at: '2026-01-01T00:00:01.000Z', line: 'connexion à la base' },
        { stream: 'stderr', at: null, line: 'mot de passe : mot-de-passe-secret' },
      ])
      host.logs.set('c-front', [{ stream: 'stdout', at: null, line: 'GET / 200' }])

      const response = await call('GET', `${envUrl()}/logs?service=back&tail=50`, undefined, viewer)
      expect(response.headers['content-type']).toContain('text/event-stream')
      const events = response.body
        .split('\n\n')
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => JSON.parse(chunk.slice(6)))
      expect(events).toEqual([
        {
          type: 'log',
          log: {
            service: 'back',
            container: 'vercio_site_prod-back-1',
            stream: 'stdout',
            at: '2026-01-01T00:00:01.000Z',
            line: 'connexion à la base',
          },
        },
        {
          type: 'log',
          log: expect.objectContaining({ stream: 'stderr', line: 'mot de passe : ••••••' }),
        },
        { type: 'end', container: 'vercio_site_prod-back-1' },
      ])
    })
  })
})
