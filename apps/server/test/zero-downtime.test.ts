import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  formatPortSpec,
  parsePortSpecs,
  planZeroDowntime,
  readiness,
  renderRelayConfig,
  zeroDowntimeEligibility,
} from '../src/deploy/zero-downtime.js'

describe('Ports d’un service', () => {
  it('lit les formes courantes et refuse ce que le relais ne sait pas reprendre', () => {
    expect(
      parsePortSpecs([
        '8080:80',
        '127.0.0.1:9000:9000',
        '3000',
        8443,
        '[::1]:5432:5432',
        { target: 80, published: 8081, host_ip: '0.0.0.0' },
      ]),
    ).toEqual([
      { hostIp: null, published: 8080, target: 80 },
      { hostIp: '127.0.0.1', published: 9000, target: 9000 },
      { hostIp: null, published: null, target: 3000 },
      { hostIp: null, published: null, target: 8443 },
      { hostIp: '[::1]', published: 5432, target: 5432 },
      { hostIp: '0.0.0.0', published: 8081, target: 80 },
    ])
    expect(parsePortSpecs(undefined)).toEqual([])
    expect(parsePortSpecs(['53:53/udp'])).toBeNull()
    expect(parsePortSpecs(['8000-8010:8000-8010'])).toBeNull()
    expect(parsePortSpecs([{ target: 53, protocol: 'udp' }])).toBeNull()
    expect(formatPortSpec({ hostIp: '127.0.0.1', published: 9000, target: 80 })).toBe(
      '127.0.0.1:9000:80',
    )
    expect(formatPortSpec({ hostIp: null, published: null, target: 80 })).toBe('80')
  })
})

describe('Éligibilité', () => {
  it('refuse ce qui empêche deux versions de coexister, prévient pour les volumes', () => {
    expect(zeroDowntimeEligibility({ image: 'nginx', ports: ['80:80'] })).toEqual({
      eligible: true,
      reason: null,
      warning: null,
    })
    expect(zeroDowntimeEligibility({ container_name: 'web' }).reason).toContain('container_name')
    expect(zeroDowntimeEligibility({ network_mode: 'host' }).reason).toContain('network_mode')
    expect(zeroDowntimeEligibility({ ports: ['53:53/udp'] }).reason).toContain('UDP')
    expect(zeroDowntimeEligibility({ deploy: { replicas: 3 } }).eligible).toBe(false)
    expect(zeroDowntimeEligibility({ volumes: ['data:/var/lib/data'] }).warning).toContain(
      'volumes',
    )
    expect(zeroDowntimeEligibility({ volumes: ['./conf:/etc/conf:ro'] }).warning).toBeNull()
  })
})

describe('Préparation du Compose', () => {
  const compose = `services:
  web:
    image: nginx
    ports: ["8080:80", "127.0.0.1:8443:443"]
    depends_on: [api]
  api:
    image: api
    networks: [default, interne]
  db:
    image: postgres
    container_name: db
networks:
  interne: {}
`

  it('retire les ports des services relayés et prépare un relais par service', () => {
    const plan = planZeroDowntime(compose, ['web', 'api', 'db', 'absent'])
    expect(plan.services).toEqual(['web', 'api'])
    expect(plan.skipped).toEqual([
      { service: 'db', reason: expect.stringContaining('container_name') },
      { service: 'absent', reason: 'absent du fichier Compose' },
    ])
    expect(plan.relays).toEqual([
      {
        service: 'web',
        name: 'vercio-relay-web',
        ports: [
          { hostIp: null, published: 8080, target: 80 },
          { hostIp: '127.0.0.1', published: 8443, target: 443 },
        ],
        networks: null,
      },
    ])
    const rendered = parse(plan.compose) as { services: Record<string, Record<string, unknown>> }
    expect(rendered.services.web).toEqual({ image: 'nginx', depends_on: ['api'] })
    expect(rendered.services.db!.container_name).toBe('db')
  })

  it('ne touche pas au fichier sans service demandé', () => {
    expect(planZeroDowntime(compose, []).compose).toBe(compose)
  })

  it('génère un relais nginx qui suit le service par son nom', () => {
    const config = renderRelayConfig({
      service: 'web',
      name: 'vercio-relay-web',
      ports: [
        { hostIp: null, published: 8080, target: 80 },
        { hostIp: '127.0.0.1', published: 8081, target: 80 },
        { hostIp: null, published: 8443, target: 443 },
      ],
      networks: null,
    })
    expect(config).toContain('resolver 127.0.0.11 valid=1s')
    expect(config.match(/listen /g)).toHaveLength(2)
    expect(config).toContain('proxy_pass http://$vercio_upstream:80;')
    expect(config).toContain('set $vercio_upstream web;')
    expect(config).toContain('proxy_next_upstream error timeout http_502;')
  })
})

describe('Disponibilité de la nouvelle version', () => {
  it('lit l’état et le healthcheck', () => {
    expect(readiness('running', 'healthy')).toBe('ready')
    expect(readiness('running', 'starting')).toBe('waiting')
    expect(readiness('running', 'none')).toBe('running')
    expect(readiness('created', 'none')).toBe('waiting')
    expect(readiness('running', 'unhealthy')).toBe('failed')
    expect(readiness('exited', 'none')).toBe('failed')
  })
})
