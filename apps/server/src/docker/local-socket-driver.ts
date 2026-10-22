import { hostname } from 'node:os'
import { PassThrough, type Duplex, type Readable } from 'node:stream'
import Docker from 'dockerode'
import type {
  CleanupPreview,
  CleanupTarget,
  ContainerAction,
  ContainerStatsSample,
  ContainerView,
  DockerInfo,
  HostContainerView,
  PublishedPort,
} from '@vercio/shared'
import type {
  ComposeContainer,
  ContainerDetails,
  ContainerState,
  DetachedRun,
  DockerEvent,
  EventOptions,
  ExecOptions,
  ExecSession,
  HostDriver,
  LogLine,
  NetworkState,
  LogOptions,
  SelfContainer,
  StatsOptions,
} from './host-driver.js'

export class LocalSocketDriver implements HostDriver {
  readonly #docker: Docker

  constructor(socketPath: string) {
    this.#docker = new Docker({ socketPath })
  }

  async ping(): Promise<boolean> {
    try {
      await this.#docker.ping()
      return true
    } catch {
      return false
    }
  }

  async info(): Promise<DockerInfo> {
    const info = await this.#docker.info()
    return {
      serverVersion: info.ServerVersion,
      operatingSystem: info.OperatingSystem,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
      containers: {
        total: info.Containers,
        running: info.ContainersRunning,
        paused: info.ContainersPaused,
        stopped: info.ContainersStopped,
      },
      images: info.Images,
    }
  }

  async listContainers(composeProject: string): Promise<ContainerView[]> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${composeProject}`] },
    })
    return containers.map(toContainerView).sort(byService)
  }

  async composeContainerViews(): Promise<Map<string, ContainerView[]>> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: ['com.docker.compose.project'] },
    })
    const result = new Map<string, ContainerView[]>()
    for (const container of containers) {
      const project = container.Labels['com.docker.compose.project'] ?? ''
      const list = result.get(project) ?? []
      list.push(toContainerView(container))
      result.set(project, list)
    }
    for (const list of result.values()) list.sort(byService)
    return result
  }

  async containerAction(containerId: string, action: ContainerAction): Promise<void> {
    const container = this.#docker.getContainer(containerId)
    try {
      // Délai avant SIGKILL : celui du conteneur (`stop_grace_period` du Compose, 10 s par défaut).
      if (action === 'start') await container.start()
      else if (action === 'stop') await container.stop()
      else await container.restart()
    } catch (error) {
      // 304 : déjà dans l'état demandé.
      if ((error as { statusCode?: number }).statusCode !== 304) throw error
    }
  }

  async watchEvents(options: EventOptions): Promise<void> {
    const stream = (await this.#docker.getEvents({
      ...(options.since ? { since: options.since } : {}),
      filters: { type: ['container'], label: ['com.docker.compose.project'] },
      abortSignal: options.signal,
    } as Docker.GetEventsOptions)) as unknown as Readable
    await new Promise<void>((resolve) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          if (!part.trim()) continue
          try {
            const raw = JSON.parse(part) as {
              Action?: string
              Actor?: { ID?: string; Attributes?: Record<string, string> }
              time?: number
              timeNano?: number
            }
            options.onEvent({
              action: raw.Action ?? '',
              id: raw.Actor?.ID ?? '',
              time: raw.time ?? Math.floor(Date.now() / 1000),
              timeNano: String(raw.timeNano ?? ''),
              attributes: raw.Actor?.Attributes ?? {},
            } satisfies DockerEvent)
          } catch {
            // Ligne illisible : ignorée.
          }
        }
      })
      stream.on('end', resolve)
      stream.on('close', resolve)
      stream.on('error', () => resolve())
      options.signal.addEventListener('abort', () => {
        stream.destroy()
        resolve()
      })
    })
  }

  async composeContainers(): Promise<ContainerState[]> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: ['com.docker.compose.project'] },
    })
    const states = await Promise.all(containers.map((item) => this.inspectContainer(item.Id)))
    return states.filter((state): state is ContainerState => state !== null)
  }

  async composeInventory(): Promise<ComposeContainer[]> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: ['com.docker.compose.project'] },
    })
    return containers.map((container) => ({
      id: container.Id,
      name: (container.Names[0] ?? container.Id).replace(/^\//, ''),
      project: container.Labels['com.docker.compose.project'] ?? '',
      service: container.Labels['com.docker.compose.service'] ?? '',
      image: container.Image,
      state: container.State,
      status: container.Status,
      labels: container.Labels,
      mounts: (container.Mounts ?? []).map((mount) => ({
        type: mount.Type,
        name: mount.Name ?? null,
        source: mount.Source,
        destination: mount.Destination,
      })),
      ports: [
        ...new Set(
          container.Ports.filter((port) => port.PublicPort).map(
            (port) => `${port.PublicPort}→${port.PrivatePort}/${port.Type}`,
          ),
        ),
      ],
    }))
  }

  async hostContainers(): Promise<HostContainerView[]> {
    const containers = await this.#docker.listContainers({ all: true })
    return containers
      .map((container) => {
        const labels = container.Labels ?? {}
        return {
          id: container.Id,
          name: (container.Names[0] ?? container.Id).replace(/^\//, ''),
          image: container.Image,
          state: container.State,
          status: container.Status,
          health: health(container.Status),
          ports: [
            ...new Set(
              container.Ports.filter((port) => port.PublicPort).map(
                (port) => `${port.PublicPort}→${port.PrivatePort}/${port.Type}`,
              ),
            ),
          ],
          createdAt: new Date(container.Created * 1000).toISOString(),
          composeProject: labels['com.docker.compose.project'] ?? null,
          service: labels['com.docker.compose.service'] ?? null,
          vercio:
            labels['vercio.managed'] === 'true' && labels['vercio.project']
              ? {
                  project: labels['vercio.project'],
                  environment: labels['vercio.environment'] ?? '',
                }
              : null,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async cleanupPreview(): Promise<CleanupPreview> {
    const df = (await this.#docker.df()) as DockerDf
    const images = df.Images ?? []
    const unusedImages = images.filter((image) => image.Containers === 0)
    const dangling = unusedImages.filter(
      (image) => !image.RepoTags?.length || image.RepoTags.every((tag) => tag === '<none>:<none>'),
    )
    // Taille propre de l'image : les couches partagées avec d'autres images restent.
    const own = (image: DfImage) => Math.max(0, image.Size - Math.max(0, image.SharedSize ?? 0))
    const stopped = (df.Containers ?? []).filter(
      (container) =>
        container.State !== 'running' && container.Labels?.['vercio.managed'] !== 'true',
    )
    const volumes = (df.Volumes ?? []).filter(
      (volume) =>
        volume.UsageData?.RefCount === 0 && volume.Labels && ANONYMOUS_VOLUME in volume.Labels,
    )
    const cache = (df.BuildCache ?? []).filter((item) => !item.InUse && !item.Shared)
    const sum = <T>(items: T[], size: (item: T) => number) =>
      items.reduce((total, item) => total + Math.max(0, size(item)), 0)
    return {
      targets: {
        'images-dangling': { count: dangling.length, bytes: sum(dangling, own) },
        'images-unused': { count: unusedImages.length, bytes: sum(unusedImages, own) },
        containers: { count: stopped.length, bytes: sum(stopped, (c) => c.SizeRw ?? 0) },
        volumes: { count: volumes.length, bytes: sum(volumes, (v) => v.UsageData?.Size ?? 0) },
        'build-cache': { count: cache.length, bytes: sum(cache, (item) => item.Size ?? 0) },
      },
      measuredAt: new Date().toISOString(),
    }
  }

  async cleanup(target: CleanupTarget): Promise<{ deleted: number; bytes: number }> {
    switch (target) {
      case 'images-dangling':
      case 'images-unused': {
        const result = await this.#docker.pruneImages({
          filters: { dangling: [target === 'images-dangling' ? 'true' : 'false'] },
        })
        return { deleted: result.ImagesDeleted?.length ?? 0, bytes: result.SpaceReclaimed ?? 0 }
      }
      case 'containers': {
        // Les conteneurs arrêtés des projets Vercio sont gardés.
        const result = await this.#docker.pruneContainers({
          filters: { 'label!': ['vercio.managed=true'] },
        })
        return {
          deleted: result.ContainersDeleted?.length ?? 0,
          bytes: result.SpaceReclaimed ?? 0,
        }
      }
      case 'volumes': {
        // Sans « all », Docker ne supprime que les volumes anonymes : jamais un volume nommé.
        const result = await this.#docker.pruneVolumes({
          filters: { label: [ANONYMOUS_VOLUME] },
        })
        return { deleted: result.VolumesDeleted?.length ?? 0, bytes: result.SpaceReclaimed ?? 0 }
      }
      case 'build-cache': {
        const result = (await this.#docker.pruneBuilder()) as {
          CachesDeleted?: string[]
          SpaceReclaimed?: number
        }
        return { deleted: result.CachesDeleted?.length ?? 0, bytes: result.SpaceReclaimed ?? 0 }
      }
    }
  }

  async inspectContainer(containerId: string): Promise<ContainerState | null> {
    try {
      return toState(await this.#docker.getContainer(containerId).inspect())
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null
      throw error
    }
  }

  async streamLogs(containerId: string, options: LogOptions): Promise<void> {
    const container = this.#docker.getContainer(containerId)
    const { Config } = await container.inspect()
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: options.tail,
      abortSignal: options.signal,
    } as Docker.ContainerLogsOptions & { follow: true })) as unknown as Readable

    const done = new Promise<void>((resolve) => {
      stream.on('end', resolve)
      stream.on('close', resolve)
      stream.on('error', () => resolve())
      options.signal.addEventListener('abort', () => {
        stream.destroy()
        resolve()
      })
    })

    if (Config.Tty) {
      lines(stream, 'stdout', options.onLine)
    } else {
      // Sans TTY, Docker multiplexe stdout et stderr dans un seul flux.
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      this.#docker.modem.demuxStream(stream, stdout, stderr)
      lines(stdout, 'stdout', options.onLine)
      lines(stderr, 'stderr', options.onLine)
      stream.on('end', () => {
        stdout.end()
        stderr.end()
      })
    }
    await done
  }

  async streamStats(containerId: string, options: StatsOptions): Promise<void> {
    const stream = (await this.#docker.getContainer(containerId).stats({
      stream: true,
      abortSignal: options.signal,
    } as { stream: true })) as unknown as Readable
    await new Promise<void>((resolve) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          if (!part.trim()) continue
          try {
            const sample = toSample(JSON.parse(part) as RawStats)
            if (sample) options.onSample(sample)
          } catch {
            // Mesure illisible : ignorée.
          }
        }
      })
      stream.on('end', resolve)
      stream.on('close', resolve)
      stream.on('error', () => resolve())
      options.signal.addEventListener('abort', () => {
        stream.destroy()
        resolve()
      })
    })
  }

  async containerDetails(containerId: string): Promise<ContainerDetails | null> {
    let info: Docker.ContainerInspectInfo
    try {
      info = await this.#docker.getContainer(containerId).inspect()
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null
      throw error
    }
    const labels = info.Config.Labels ?? {}
    const healthState = (
      info.State as {
        Health?: {
          Status?: string
          FailingStreak?: number
          Log?: { Start?: string; ExitCode?: number; Output?: string }[]
        }
      }
    ).Health
    const asList = (value: string | string[] | null | undefined) =>
      Array.isArray(value) ? value : value ? [value] : []
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      service: labels['com.docker.compose.service'] ?? '',
      image: info.Config.Image,
      imageId: info.Image,
      createdAt: info.Created,
      startedAt: info.State.StartedAt?.startsWith('0001') ? null : (info.State.StartedAt ?? null),
      state: info.State.Status,
      restartCount: info.RestartCount,
      restartPolicy: info.HostConfig.RestartPolicy?.Name || 'no',
      command: asList(info.Config.Cmd),
      entrypoint: asList(info.Config.Entrypoint as string | string[] | null),
      workingDir: info.Config.WorkingDir ?? '',
      user: info.Config.User ?? '',
      env: (info.Config.Env ?? []).map((entry) => {
        const index = entry.indexOf('=')
        return index < 0
          ? { key: entry, value: '' }
          : { key: entry.slice(0, index), value: entry.slice(index + 1) }
      }),
      mounts: (info.Mounts ?? []).map((mount) => ({
        type: mount.Type,
        source: (mount as { Name?: string }).Name || mount.Source,
        destination: mount.Destination,
        readOnly: !mount.RW,
      })),
      networks: Object.entries(info.NetworkSettings.Networks ?? {}).map(([name, network]) => ({
        name,
        ip: network.IPAddress || null,
        aliases: ((network.Aliases ?? []) as string[]).filter(
          (alias) => !info.Id.startsWith(alias),
        ),
      })),
      ports: Object.entries(info.NetworkSettings.Ports ?? {}).flatMap(([port, bindings]) =>
        bindings?.length
          ? [
              ...new Set(
                bindings.map(
                  (binding) =>
                    `${binding.HostIp && binding.HostIp !== '0.0.0.0' && binding.HostIp !== '::' ? `${binding.HostIp}:` : ''}${binding.HostPort}→${port}`,
                ),
              ),
            ]
          : [port],
      ),
      labels,
      health: healthState?.Status
        ? {
            status: healthState.Status,
            failingStreak: healthState.FailingStreak ?? 0,
            log: (healthState.Log ?? []).map((entry) => ({
              start: entry.Start ?? '',
              exitCode: entry.ExitCode ?? -1,
              output: (entry.Output ?? '').slice(0, 4000),
            })),
          }
        : null,
    }
  }

  async exec(containerId: string, options: ExecOptions): Promise<ExecSession> {
    const exec = await this.#docker.getContainer(containerId).exec({
      Cmd: options.cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color', `COLUMNS=${options.cols}`, `LINES=${options.rows}`],
    })
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex
    const resize = async (cols: number, rows: number) => {
      try {
        await exec.resize({ w: cols, h: rows })
      } catch {
        // Processus déjà terminé.
      }
    }
    await resize(options.cols, options.rows)
    const exited = new Promise<number | null>((resolve) => {
      let done = false
      const finish = async () => {
        if (done) return
        done = true
        try {
          const state = await exec.inspect()
          resolve(state.Running ? null : (state.ExitCode ?? null))
        } catch {
          resolve(null)
        }
      }
      stream.on('end', finish)
      stream.on('close', finish)
      stream.on('error', finish)
    })
    return {
      write: (data) => {
        if (!stream.destroyed) stream.write(data)
      },
      resize,
      onData: (listener) => stream.on('data', listener),
      pause: () => stream.pause(),
      resume: () => stream.resume(),
      exited,
      close: () => stream.destroy(),
    }
  }

  async networks(names: string[]): Promise<Map<string, NetworkState>> {
    const result = new Map<string, NetworkState>()
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = (await this.#docker.getNetwork(name).inspect()) as {
            Containers?: Record<string, { Name?: string }>
          }
          const ids = Object.keys(info.Containers ?? {})
          // Le projet Compose de chaque conteneur : la liste du réseau ne donne que son nom.
          const containers = ids.length
            ? await this.#docker.listContainers({ all: true, filters: { id: ids } })
            : []
          result.set(name, {
            containers: containers
              .map((container) => ({
                name: (container.Names[0] ?? container.Id).replace(/^\//, ''),
                project: container.Labels?.['com.docker.compose.project'] ?? null,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          })
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error
        }
      }),
    )
    return result
  }

  async connectNetwork(name: string, containers: { id: string; aliases: string[] }[]) {
    try {
      await this.#docker.getNetwork(name).inspect()
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error
      try {
        // Mêmes labels que le réseau créé au déploiement.
        await this.#docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Labels: { 'vercio.managed': 'true', 'vercio.shared-network': name },
        })
      } catch (created) {
        // Créé entre-temps par un déploiement.
        if ((created as { statusCode?: number }).statusCode !== 409) throw created
      }
    }
    const network = this.#docker.getNetwork(name)
    for (const container of containers) {
      try {
        await network.connect({
          Container: container.id,
          EndpointConfig: container.aliases.length ? { Aliases: container.aliases } : {},
        })
      } catch (error) {
        // Déjà branché (403 ou 409 selon la version de Docker).
        const status = (error as { statusCode?: number }).statusCode
        if (status !== 403 && status !== 409) throw error
      }
    }
  }

  async selfContainer(): Promise<SelfContainer | null> {
    try {
      const info = await this.#docker.getContainer(hostname()).inspect()
      return {
        id: info.Id,
        image: info.Config.Image,
        labels: info.Config.Labels ?? {},
        mounts: (info.Mounts ?? []).map((mount) => ({
          source: mount.Source,
          destination: mount.Destination,
        })),
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null
      throw error
    }
  }

  async runDetached(options: DetachedRun): Promise<string> {
    try {
      await this.#docker.getImage(options.image).inspect()
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.#docker.pull(options.image, (error: Error | null, stream: NodeJS.ReadableStream) => {
          if (error) return reject(error)
          this.#docker.modem.followProgress(stream, (failure: Error | null) =>
            failure ? reject(failure) : resolve(),
          )
        })
      })
    }
    const container = await this.#docker.createContainer({
      Image: options.image,
      Cmd: options.command,
      Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
      Labels: options.labels,
      HostConfig: {
        Binds: options.binds,
        AutoRemove: true,
        // Le conteneur ne parle qu'au démon Docker (socket) : pas besoin de réseau.
        NetworkMode: 'none',
      },
    })
    await container.start()
    return container.id
  }

  async removeNetwork(name: string): Promise<'removed' | 'missing' | 'in_use'> {
    try {
      await this.#docker.getNetwork(name).remove()
      return 'removed'
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404) return 'missing'
      if (status === 403 || status === 409) return 'in_use'
      throw error
    }
  }
}

interface RawStats {
  read?: string
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> }
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>
  blkio_stats?: { io_service_bytes_recursive?: { op?: string; value?: number }[] | null }
  pids_stats?: { current?: number }
}

/** Mesure Docker brute → mesure lisible (mêmes calculs que `docker stats`). */
export function toSample(raw: RawStats): ContainerStatsSample | null {
  // Conteneur arrêté : Docker envoie une mesure vide.
  if (!raw.read || raw.read.startsWith('0001') || !raw.memory_stats?.usage) return null
  const cpu = raw.cpu_stats
  const pre = raw.precpu_stats
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0)
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0)
  const cpus = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length || 1
  const memoryStats = raw.memory_stats.stats ?? {}
  // cgroup v2 : inactive_file ; v1 : total_inactive_file.
  const cache = memoryStats.inactive_file ?? memoryStats.total_inactive_file ?? 0
  let netRx = 0
  let netTx = 0
  for (const network of Object.values(raw.networks ?? {})) {
    netRx += network.rx_bytes ?? 0
    netTx += network.tx_bytes ?? 0
  }
  let blockRead = 0
  let blockWrite = 0
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = entry.op?.toLowerCase()
    if (op === 'read') blockRead += entry.value ?? 0
    else if (op === 'write') blockWrite += entry.value ?? 0
  }
  return {
    at: raw.read,
    cpuPercent:
      pre?.system_cpu_usage && systemDelta > 0 && cpuDelta >= 0
        ? Math.round((cpuDelta / systemDelta) * cpus * 1000) / 10
        : null,
    memoryBytes: Math.max(0, raw.memory_stats.usage - cache),
    memoryLimitBytes: raw.memory_stats.limit ?? 0,
    netRxBytes: netRx,
    netTxBytes: netTx,
    blockReadBytes: blockRead,
    blockWriteBytes: blockWrite,
    pids: raw.pids_stats?.current ?? 0,
  }
}

/** Label posé par Docker (23 et plus) sur les volumes anonymes. */
const ANONYMOUS_VOLUME = 'com.docker.volume.anonymous'

interface DfImage {
  Containers: number
  Size: number
  SharedSize?: number
  RepoTags?: string[] | null
}
interface DockerDf {
  Images?: DfImage[]
  Containers?: { State: string; SizeRw?: number; Labels?: Record<string, string> }[]
  Volumes?: {
    Labels?: Record<string, string> | null
    UsageData?: { RefCount: number; Size: number } | null
  }[]
  BuildCache?: { InUse: boolean; Shared: boolean; Size?: number }[]
}

function toState(info: Docker.ContainerInspectInfo): ContainerState {
  const labels = info.Config.Labels ?? {}
  const healthStatus = (info.State as { Health?: { Status?: string } }).Health?.Status
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    project: labels['com.docker.compose.project'] ?? '',
    service: labels['com.docker.compose.service'] ?? '',
    number: labels['com.docker.compose.container-number'] ?? '1',
    oneoff: labels['com.docker.compose.oneoff'] === 'True',
    running: info.State.Running,
    restarting: info.State.Restarting,
    // Docker garde le dernier état du healthcheck d'un conteneur arrêté : sans objet.
    health:
      info.State.Running &&
      (healthStatus === 'healthy' || healthStatus === 'unhealthy' || healthStatus === 'starting')
        ? healthStatus
        : null,
    exitCode: info.State.Running ? null : info.State.ExitCode,
    oomKilled: info.State.OOMKilled,
    restartCount: info.RestartCount,
    restartPolicy: info.HostConfig.RestartPolicy?.Name || 'no',
    finishedAt: info.State.FinishedAt?.startsWith('0001') ? null : (info.State.FinishedAt ?? null),
  }
}

function health(status: string): ContainerView['health'] {
  if (status.includes('(healthy)')) return 'healthy'
  if (status.includes('(unhealthy)')) return 'unhealthy'
  if (status.includes('(health: starting)')) return 'starting'
  return null
}

/** Découpe un flux en lignes et sépare l'horodatage ajouté par Docker. */
function lines(stream: Readable, name: LogLine['stream'], onLine: (line: LogLine) => void) {
  let buffer = ''
  const emit = (raw: string) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\S+Z) (.*)$/s.exec(raw)
    onLine({ stream: name, at: match ? match[1]! : null, line: match ? match[2]! : raw })
  }
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) emit(part.replace(/\r$/, ''))
  })
  stream.on('end', () => {
    if (buffer) emit(buffer)
  })
}

const byService = (a: ContainerView, b: ContainerView) =>
  a.service.localeCompare(b.service) || a.name.localeCompare(b.name)

/** Adresse d'écoute significative : null pour « toutes les interfaces ». */
const listenAddress = (ip: string | undefined) =>
  ip && ip !== '0.0.0.0' && ip !== '::' ? ip : null

export function toContainerView(container: Docker.ContainerInfo): ContainerView {
  const labels = container.Labels ?? {}
  const published = new Map<string, PublishedPort>()
  for (const port of container.Ports ?? []) {
    if (!port.PublicPort) continue
    const item = {
      ip: listenAddress(port.IP),
      hostPort: port.PublicPort,
      containerPort: port.PrivatePort,
      protocol: port.Type,
    }
    // IPv4 et IPv6 publient le même port : une seule entrée.
    published.set(`${item.ip}:${item.hostPort}/${item.protocol}`, item)
  }
  const ports = [...published.values()]
  return {
    id: container.Id,
    name: (container.Names[0] ?? container.Id).replace(/^\//, ''),
    service: labels['com.docker.compose.service'] ?? '',
    image: container.Image,
    state: container.State,
    status: container.Status,
    health: health(container.Status),
    createdAt: new Date(container.Created * 1000).toISOString(),
    ports: ports.map(
      (port) =>
        `${port.ip ? `${port.ip}:` : ''}${port.hostPort}→${port.containerPort}/${port.protocol}`,
    ),
    published: ports,
    networks: Object.keys(container.NetworkSettings?.Networks ?? {}).sort(),
    dependsOn: parseDependsOn(labels['com.docker.compose.depends_on']),
    relayFor: labels['vercio.relay-for'] ?? null,
  }
}

/** Label Compose `db:service_started:false,redis:service_healthy:true` → `[db, redis]`. */
export function parseDependsOn(label: string | undefined): string[] {
  if (!label) return []
  return [
    ...new Set(
      label
        .split(',')
        .map((item) => item.split(':')[0]!.trim())
        .filter(Boolean),
    ),
  ].sort()
}
