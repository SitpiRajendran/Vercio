import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { loadConfig, resolveDockerSocket } from '../src/config.js'
import { describeDatabaseError, waitForDatabase } from '../src/db/client.js'

const base = {
  PUBLIC_URL: 'https://vercio.example.com',
  DATABASE_URL: 'postgres://localhost/vercio',
  VERCIO_SECRET_KEY: 'x'.repeat(32),
}

describe('loadConfig', () => {
  it('applique les valeurs par défaut', () => {
    const config = loadConfig(base)
    expect(config.PORT).toBe(9000)
    expect(config.VERCIO_LOCAL_AUTH).toBe(true)
    expect(config.LOG_PRETTY).toBe(false)
  })

  it('refuse une clé de chiffrement trop courte', () => {
    expect(() => loadConfig({ ...base, VERCIO_SECRET_KEY: 'court' })).toThrow(/VERCIO_SECRET_KEY/)
  })

  it('traite une variable vide comme absente', () => {
    const config = loadConfig({ ...base, OIDC_ISSUER: '', VERCIO_ADMIN_PASSWORD: '' })
    expect(config.OIDC_ISSUER).toBeUndefined()
    expect(config.VERCIO_ADMIN_PASSWORD).toBeUndefined()
  })

  it('exige le client OIDC avec l’émetteur', () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER: 'https://sso.example.com/realms/x' })).toThrow(
      /OIDC_CLIENT_ID/,
    )
  })

  it('rend absolus les chemins relatifs (VERCIO_DATA_DIR=./data en développement)', () => {
    // Docker est lancé depuis le dossier de l'environnement : un chemin relatif y serait faux.
    const config = loadConfig({
      ...base,
      VERCIO_DATA_DIR: './data',
      DOCKER_SOCKET: 'run/docker.sock',
      WEB_DIST_DIR: '../web/dist',
    })
    expect(config.VERCIO_DATA_DIR).toBe(resolve('data'))
    expect(config.DOCKER_SOCKET).toBe(resolve('run/docker.sock'))
    expect(config.WEB_DIST_DIR).toBe(resolve('../web/dist'))
    expect(loadConfig(base).VERCIO_DATA_DIR).toBe('/var/lib/vercio')
  })

  it('exige au moins un mode de connexion', () => {
    expect(() => loadConfig({ ...base, VERCIO_LOCAL_AUTH: 'false' })).toThrow(/mode de connexion/)
  })
})

describe('Socket Docker', () => {
  const none = () => false

  it('suit DOCKER_SOCKET, puis DOCKER_HOST', () => {
    expect(resolveDockerSocket({ DOCKER_SOCKET: '/a.sock', DOCKER_HOST: 'unix:///b.sock' })).toBe(
      '/a.sock',
    )
    expect(resolveDockerSocket({ DOCKER_HOST: 'unix:///b.sock' })).toBe('/b.sock')
  })

  it('trouve le socket de Docker Desktop sur Mac', () => {
    const socket = resolveDockerSocket(
      { DOCKER_HOST: 'tcp://10.0.0.1:2376' },
      (path) => path === '/Users/alice/.docker/run/docker.sock',
      '/Users/alice',
    )
    expect(socket).toBe('/Users/alice/.docker/run/docker.sock')
  })

  it('garde l’emplacement Linux par défaut quand rien n’est trouvé', () => {
    expect(resolveDockerSocket({}, none, '/home/bob')).toBe('/var/run/docker.sock')
  })
})

describe('Connexion à la base', () => {
  const url = 'postgres://vercio:secret@localhost:5432/vercio'

  it('explique les erreurs courantes', () => {
    expect(describeDatabaseError({ code: 'ECONNREFUSED' }, url)).toBe(
      'PostgreSQL ne répond pas sur localhost:5432/vercio (connexion refusée) : la base est-elle démarrée ?',
    )
    // Node regroupe les échecs IPv4 / IPv6 dans une AggregateError.
    expect(describeDatabaseError({ errors: [{ code: 'ECONNREFUSED' }] }, url)).toContain(
      'connexion refusée',
    )
    expect(describeDatabaseError({ code: '28P01' }, url)).toContain('mot de passe')
    expect(describeDatabaseError({ code: '3D000' }, url)).toContain("n'existe pas")
    // Le mot de passe de DATABASE_URL n'apparaît jamais dans le message.
    expect(describeDatabaseError({ code: 'X', message: 'oups' }, url)).not.toContain('secret')
  })

  it('abandonne avec un message lisible si la base reste injoignable', async () => {
    // Port fermé : connexion refusée immédiatement.
    const unreachable = 'postgres://vercio:secret@127.0.0.1:1/vercio'
    const sql = postgres(unreachable, { max: 1, onnotice: () => {} })
    const retries: string[] = []
    await expect(
      waitForDatabase(sql, unreachable, {
        timeoutMs: 300,
        intervalMs: 100,
        onRetry: (message) => retries.push(message),
      }),
    ).rejects.toThrow('PostgreSQL ne répond pas sur 127.0.0.1:1/vercio')
    expect(retries).toHaveLength(1)
    await sql.end()
  })
})
