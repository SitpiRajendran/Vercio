import { describe, expect, it } from 'vitest'
import { toContainerView, toSample } from '../src/docker/local-socket-driver.js'

describe('Mesures Docker', () => {
  it('calcule CPU, mémoire hors cache, réseau et disque comme docker stats', () => {
    const sample = toSample({
      read: '2026-10-16T10:00:01Z',
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000_000 },
        system_cpu_usage: 20_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 16_000_000_000 },
      memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 5, tx_bytes: 1 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'read', value: 7 },
          { op: 'Write', value: 9 },
          { op: 'Total', value: 16 },
        ],
      },
      pids_stats: { current: 4 },
    })
    expect(sample).toEqual({
      at: '2026-10-16T10:00:01Z',
      // 1 s de CPU sur 4 s de temps système (4 cœurs) : 100 % d'un cœur.
      cpuPercent: 100,
      memoryBytes: 200,
      memoryLimitBytes: 1000,
      netRxBytes: 15,
      netTxBytes: 21,
      blockReadBytes: 7,
      blockWriteBytes: 9,
      pids: 4,
    })
  })

  it('n’invente pas de CPU sur la première mesure, ni de mesure pour un conteneur arrêté', () => {
    expect(
      toSample({
        read: '2026-10-16T10:00:00Z',
        cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 10, online_cpus: 2 },
        precpu_stats: {},
        memory_stats: { usage: 100, limit: 1000, stats: { total_inactive_file: 40 } },
      }),
    ).toMatchObject({ cpuPercent: null, memoryBytes: 60 })
    expect(toSample({ read: '0001-01-01T00:00:00Z', memory_stats: {} })).toBeNull()
  })
})

describe('Conteneurs listés par Docker', () => {
  it('détaille ports publiés, réseaux et dépendances', () => {
    const view = toContainerView({
      Id: 'abc',
      Names: ['/vercio_site_prod-web-1'],
      Image: 'nginx',
      ImageID: 'sha256:1',
      Command: '',
      Created: 1_700_000_000,
      State: 'running',
      Status: 'Up 3 minutes (healthy)',
      Labels: {
        'com.docker.compose.service': 'web',
        'com.docker.compose.depends_on': 'redis:service_healthy:true,api:service_started:false',
      },
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { IP: '127.0.0.1', PrivatePort: 9000, PublicPort: 9000, Type: 'tcp' },
        { PrivatePort: 443, Type: 'tcp' } as never,
      ],
      HostConfig: { NetworkMode: 'default' },
      NetworkSettings: {
        Networks: { vercio_site_prod_default: {} as never, 'vercio-shared-db': {} as never },
      },
      Mounts: [],
    })
    expect(view).toMatchObject({
      service: 'web',
      health: 'healthy',
      ports: ['8080→80/tcp', '127.0.0.1:9000→9000/tcp'],
      published: [
        { ip: null, hostPort: 8080, containerPort: 80, protocol: 'tcp' },
        { ip: '127.0.0.1', hostPort: 9000, containerPort: 9000, protocol: 'tcp' },
      ],
      networks: ['vercio-shared-db', 'vercio_site_prod_default'],
      dependsOn: ['api', 'redis'],
    })
  })
})
