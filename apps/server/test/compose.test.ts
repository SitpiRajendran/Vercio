import { describe, expect, it } from 'vitest'
import { analyzeCompose } from '../src/compose/analyze.js'

describe('analyzeCompose', () => {
  it('liste les services, images et ports', () => {
    const result = analyzeCompose(`
services:
  front:
    image: registry.gitlab.com/acme/site/front:\${VERSION:-latest}
    ports: ["8080:80"]
  back:
    image: registry.gitlab.com/acme/site/back:latest
    ports:
      - target: 3000
        published: 3001
    networks: [default, interne]
    depends_on:
      redis:
        condition: service_healthy
    environment:
      - SECRET_KEY
      - DATABASE_URL=postgres://\${DB_USER}@db/app
    env_file: .env
  redis:
    network_mode: host
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
`)
    expect(result.error).toBeNull()
    expect(result.services).toEqual([
      {
        name: 'front',
        image: 'registry.gitlab.com/acme/site/front:${VERSION:-latest}',
        hasBuild: false,
        ports: ['8080:80'],
        hasHealthcheck: false,
        restart: null,
        networks: null,
        networkMode: null,
        dependsOn: [],
        variables: ['VERSION'],
        envFile: false,
        zeroDowntime: { eligible: true, reason: null, warning: null },
      },
      {
        name: 'back',
        image: 'registry.gitlab.com/acme/site/back:latest',
        hasBuild: false,
        ports: ['3001:3000'],
        hasHealthcheck: false,
        restart: null,
        networks: ['default', 'interne'],
        networkMode: null,
        dependsOn: ['redis'],
        variables: ['DB_USER', 'SECRET_KEY'],
        envFile: true,
        zeroDowntime: { eligible: true, reason: null, warning: null },
      },
      {
        name: 'redis',
        image: 'redis:7',
        hasBuild: false,
        ports: [],
        hasHealthcheck: true,
        restart: null,
        networks: null,
        networkMode: 'host',
        dependsOn: [],
        variables: [],
        envFile: false,
        zeroDowntime: {
          eligible: false,
          reason: 'network_mode: host : deux versions ne peuvent pas coexister',
          warning: null,
        },
      },
    ])
  })

  it('signale les points d’attention', () => {
    const result = analyzeCompose(`
services:
  app:
    build: .
    container_name: app
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
  tool:
    image: alpine
    privileged: true
`)
    expect(result.error).toBeNull()
    const text = result.warnings.join('\n')
    expect(text).toContain('construit localement')
    expect(text).toContain('container_name')
    expect(text).toContain('socket Docker')
    expect(text).toContain('chemin relatif')
    expect(text).toContain('privilégié')
  })

  it('refuse un fichier invalide', () => {
    expect(analyzeCompose('services: [').error).toContain('YAML invalide')
    expect(analyzeCompose('version: "3"').error).toContain('services')
    expect(analyzeCompose('services:\n  a:\n    ports: ["80"]').error).toContain('pas d’image')
    expect(analyzeCompose('services: {}').error).toContain('vide')
  })

  it('résiste aux bombes YAML', () => {
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
services: [*f]`
    expect(analyzeCompose(bomb).error).toBeTruthy()
  })
})

describe('variables utilisées par le fichier Compose', () => {
  it('repère les interpolations et les variables transmises par leur nom', () => {
    const result = analyzeCompose(`
services:
  app:
    image: app:\${VERSION:-1}
    command: echo $$HOME $GREETING
    environment:
      - DB_HOST=db
      - API_KEY
  worker:
    image: worker
    environment:
      MODE: batch
      SECRET:
`)
    expect(result.variables).toEqual(['API_KEY', 'GREETING', 'SECRET', 'VERSION'])
    expect(result.envFile).toBe(false)
    expect(analyzeCompose('services:\n  a:\n    image: a\n    env_file: .env\n').envFile).toBe(true)
  })
})
