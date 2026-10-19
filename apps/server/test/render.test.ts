import { describe, expect, it } from 'vitest'
import type { RunOptions } from '../src/deploy/command.js'
import { parse } from 'yaml'
import { composeFailure, describeComposeFailure } from '../src/deploy/diagnostics.js'
import { parseDotenv } from '../src/compose/dotenv.js'
import {
  maskSecrets,
  registryHost,
  detectPluginDirs,
  dockerPluginDirs,
  envFilePaths,
  renderDockerConfig,
  renderEnvFile,
  renderOverride,
} from '../src/deploy/render.js'

describe('rendu du déploiement', () => {
  it('épingle les images suivies et étiquette tous les services', () => {
    const override = parse(
      renderOverride({
        projectSlug: 'site',
        environmentSlug: 'prod',
        deploymentId: 'd1',
        services: ['front', 'redis'],
        images: { front: 'registry.example.com/acme/front@sha256:abc' },
      }),
    )
    expect(override.services.front.image).toBe('registry.example.com/acme/front@sha256:abc')
    expect(override.services.redis.image).toBeUndefined()
    expect(override.services.redis.labels).toMatchObject({
      'vercio.managed': 'true',
      'vercio.project': 'site',
      'vercio.environment': 'prod',
      'vercio.deployment': 'd1',
    })
    // Sans politique : rien n'est ajouté (comportement d'avant).
    expect(override.services.front.restart).toBeUndefined()
  })

  it('ajoute la politique de redémarrage, sauf aux services qui fixent la leur', () => {
    const render = (restartPolicy: string) =>
      parse(
        renderOverride({
          projectSlug: 'site',
          environmentSlug: 'prod',
          deploymentId: 'd1',
          services: ['front', 'worker'],
          images: {},
          restartPolicy,
          ownRestart: ['worker'],
        }),
      )
    const override = render('unless-stopped')
    expect(override.services.front.restart).toBe('unless-stopped')
    expect(override.services.worker.restart).toBeUndefined()
    expect(render('no').services.front.restart).toBeUndefined()
  })

  it('produit une configuration Docker avec les identifiants', () => {
    const config = JSON.parse(
      renderDockerConfig([{ host: 'ghcr.io', username: 'bot', password: 'p@ss' }]),
    )
    expect(Buffer.from(config.auths['ghcr.io'].auth, 'base64').toString()).toBe('bot:p@ss')
    expect(registryHost('https://harbor.example.com:8443/')).toBe('harbor.example.com:8443')
  })

  it('garde les plugins Docker de l’utilisateur (Compose de Docker Desktop)', () => {
    const dirs = dockerPluginDirs({}, '/Users/alice', (dir) =>
      ['/Users/alice/.docker/cli-plugins', '/opt/homebrew/lib/docker/cli-plugins'].includes(dir),
    )
    expect(dirs).toEqual([
      '/Users/alice/.docker/cli-plugins',
      '/opt/homebrew/lib/docker/cli-plugins',
    ])
    expect(dockerPluginDirs({ DOCKER_CONFIG: '/etc/docker-cfg' }, '/root', () => true)[0]).toBe(
      '/etc/docker-cfg/cli-plugins',
    )
    const config = JSON.parse(renderDockerConfig([], dirs))
    expect(config.cliPluginsExtraDirs).toEqual(dirs)
    expect(JSON.parse(renderDockerConfig([])).cliPluginsExtraDirs).toBeUndefined()
  })

  it('demande à Docker où sont ses plugins', async () => {
    const runner = {
      run: async (_command: string, args: string[], options: RunOptions) => {
        expect(args).toEqual(['info', '--format', '{{json .ClientInfo.Plugins}}'])
        options.onLine(
          JSON.stringify([
            { Name: 'compose', Path: '/Users/alice/.docker/cli-plugins/docker-compose' },
            { Name: 'buildx', Path: '/usr/local/lib/docker/cli-plugins/docker-buildx' },
          ]),
          'stdout',
        )
        return { code: 0 }
      },
    }
    expect(await detectPluginDirs(runner)).toEqual([
      '/Users/alice/.docker/cli-plugins',
      '/usr/local/lib/docker/cli-plugins',
    ])
    // Docker absent ou réponse illisible : aucune détection, pas d'erreur.
    expect(await detectPluginDirs({ run: async () => ({ code: 1 }) })).toEqual([])
  })

  it('masque les secrets dans le journal', () => {
    expect(maskSecrets('connexion postgres://u:s3cret@db', ['s3cret', 'ab'])).toBe(
      'connexion postgres://u:••••••@db',
    )
    // Formes encodées : DSN (caractères spéciaux) et base64 (en-tête Basic).
    expect(maskSecrets('postgres://u:p%40ss%2Fw0rd@db', ['p@ss/w0rd'])).toBe(
      'postgres://u:••••••@db',
    )
    expect(maskSecrets(`Basic ${Buffer.from('p@ss/w0rd').toString('base64')}`, ['p@ss/w0rd'])).toBe(
      'Basic ••••••',
    )
  })
})

describe('env_file du Compose', () => {
  it('liste les fichiers relatifs au dossier de l’environnement', () => {
    const compose = `services:
  a:
    env_file: .env
  b:
    env_file: [conf/app.env, { path: ./x.env, required: false }, /etc/abs.env, ../out.env, .env]
  c:
    image: alpine
`
    expect(envFilePaths(compose)).toEqual(['.env', 'conf/app.env', 'x.env'])
    expect(envFilePaths('services: [')).toEqual([])
  })

  it('écrit des valeurs prises littéralement', () => {
    expect(renderEnvFile({ A: 'simple $HOME', B: 'l\'a $X "q" \\x', C: 'l1\nl2', D: '' })).toBe(
      `A='simple $HOME'\nB="l'a \\$X \\"q\\" \\\\x"\nC="l1\\nl2"\nD=''\n`,
    )
  })
})

describe('échec de docker compose', () => {
  it('trouve la cause dans la sortie de Docker', () => {
    expect(
      composeFailure([
        'Container x-db-1 Starting',
        'Error response from daemon: failed to set up container networking: Bind for 0.0.0.0:14432 failed: port is already allocated',
      ]),
    ).toEqual({ kind: 'port_allocated', address: '0.0.0.0', port: '14432' })
    expect(
      composeFailure([
        'Error response from daemon: driver failed: listen tcp4 0.0.0.0:8080: bind: address already in use',
      ]),
    ).toEqual({ kind: 'port_in_use', port: '8080' })
    expect(composeFailure(['container site-prod-back-1 is unhealthy'])).toEqual({
      kind: 'unhealthy',
      container: 'site-prod-back-1',
    })
    expect(composeFailure(['container site-prod-back-1 exited (1)'])).toEqual({
      kind: 'exited',
      container: 'site-prod-back-1',
      code: '1',
    })
    expect(composeFailure(['exec /app: exec format error'])).toEqual({ kind: 'exec_format' })
    expect(composeFailure(['Error response from daemon: no space left on device'])).toEqual({
      kind: 'daemon',
      message: 'no space left on device',
    })
    expect(composeFailure(['rien d’utile'])).toBeNull()
    expect(
      describeComposeFailure({ kind: 'port_allocated', address: '0.0.0.0', port: '80' }, null),
    ).toContain('par un autre conteneur')
  })
})

describe('reprise d’un projet existant', () => {
  it('réutilise les volumes du projet d’origine', () => {
    const override = parse(
      renderOverride({
        projectSlug: 'budgie',
        environmentSlug: 'prod',
        deploymentId: 'd1',
        services: ['db'],
        images: {},
        volumes: { pgdata: 'budgie_pgdata' },
      }),
    )
    expect(override.volumes).toEqual({ pgdata: { name: 'budgie_pgdata', external: true } })
  })

  it('lit un .env au format de Docker Compose', () => {
    expect(
      parseDotenv(
        [
          '# commentaire',
          'export APP_URL=https://budgie.example.com',
          "SESSION_SECRET='a$b\\c'",
          'MESSAGE="ligne 1\\nligne 2 \\"citée\\""',
          'PORT=3000 # commentaire de fin',
          'MULTI="a',
          'b"',
          'invalide',
          'DATABASE_URL=postgres://u:p@db/budgie',
        ].join('\n'),
      ),
    ).toEqual([
      { key: 'APP_URL', value: 'https://budgie.example.com', secret: false },
      { key: 'SESSION_SECRET', value: 'a$b\\c', secret: true },
      { key: 'MESSAGE', value: 'ligne 1\nligne 2 "citée"', secret: false },
      { key: 'PORT', value: '3000', secret: false },
      { key: 'MULTI', value: 'a\nb', secret: false },
      { key: 'DATABASE_URL', value: 'postgres://u:p@db/budgie', secret: true },
    ])
  })
})

describe('réseaux partagés', () => {
  it('rattache les services au réseau externe sans perdre le réseau par défaut', () => {
    const override = parse(
      renderOverride({
        projectSlug: 'site',
        environmentSlug: 'prod',
        deploymentId: 'd1',
        services: ['web', 'worker', 'cron'],
        images: {},
        explicitNetworks: ['worker'],
        sharedNetworks: [
          { name: 'vercio-shared-pg', services: { web: [], worker: [] } },
          { name: 'vercio-shared-cache', services: { web: ['cache-prod'] } },
        ],
      }),
    )
    expect(override.networks).toEqual({
      'vercio-shared-pg': { name: 'vercio-shared-pg', external: true },
      'vercio-shared-cache': { name: 'vercio-shared-cache', external: true },
    })
    expect(override.services.web.networks).toEqual({
      default: {},
      'vercio-shared-pg': {},
      'vercio-shared-cache': { aliases: ['cache-prod'] },
    })
    // Réseaux déclarés dans le Compose : fusionnés par Compose, `default` n'est pas ajouté.
    expect(override.services.worker.networks).toEqual({ 'vercio-shared-pg': {} })
    expect(override.services.cron.networks).toBeUndefined()
  })
})

describe('variables d’un service seul', () => {
  it('transmet les variables par leur nom, sans écrire leur valeur', () => {
    const text = renderOverride({
      projectSlug: 'db',
      environmentSlug: 'prod',
      deploymentId: 'd1',
      services: ['postgres'],
      images: {},
      passVariables: ['POSTGRES_PASSWORD', 'POSTGRES_USER'],
    })
    expect(parse(text).services.postgres.environment).toEqual([
      'POSTGRES_PASSWORD',
      'POSTGRES_USER',
    ])
    expect(text).not.toContain('=')
  })
})
