import type {
  CleanupPreview,
  CleanupTarget,
  ContainerAction,
  ContainerInspectView,
  ContainerStatsSample,
  ContainerView,
  DockerInfo,
  HostContainerView,
} from '@vercio/shared'

export interface LogLine {
  stream: 'stdout' | 'stderr'
  /** Horodatage Docker (ISO 8601), si présent. */
  at: string | null
  line: string
}

export interface LogOptions {
  /** Nombre de lignes déjà écrites à renvoyer avant le direct. */
  tail: number
  signal: AbortSignal
  onLine: (line: LogLine) => void
}

/** Évènement Docker d'un conteneur (`docker events`). */
export interface DockerEvent {
  /** start, die, kill, oom, destroy, « health_status: unhealthy »… */
  action: string
  id: string
  /** Secondes Unix. */
  time: number
  timeNano: string
  /** Labels du conteneur, `exitCode`, `signal`, `name`. */
  attributes: Record<string, string>
}

export interface EventOptions {
  /** Relit les évènements depuis cet instant (secondes Unix, tampon du démon). */
  since?: number
  signal: AbortSignal
  onEvent: (event: DockerEvent) => void
}

/** État d'un conteneur Compose, pour les alertes. */
export interface ContainerState {
  id: string
  name: string
  /** Projet Compose (`com.docker.compose.project`). */
  project: string
  service: string
  /** Numéro du conteneur dans le service (`com.docker.compose.container-number`). */
  number: string
  /** Conteneur ponctuel (`docker compose run`). */
  oneoff: boolean
  running: boolean
  restarting: boolean
  health: 'healthy' | 'unhealthy' | 'starting' | null
  exitCode: number | null
  oomKilled: boolean
  restartCount: number
  restartPolicy: string
  finishedAt: string | null
}

/** Conteneur d'un projet Compose, avec ce qu'il faut pour le reprendre dans Vercio. */
export interface ComposeContainer {
  id: string
  name: string
  project: string
  service: string
  image: string
  state: string
  status: string
  labels: Record<string, string>
  mounts: { type: string; name: string | null; source: string; destination: string }[]
  ports: string[]
}

export interface StatsOptions {
  signal: AbortSignal
  /** Environ une mesure par seconde, tant que le conteneur tourne. */
  onSample: (sample: ContainerStatsSample) => void
}

/** Détail d'un conteneur, variables en clair : le masquage revient à l'appelant. */
export type ContainerDetails = Omit<ContainerInspectView, 'env'> & {
  env: { key: string; value: string }[]
}

export interface ExecOptions {
  cmd: string[]
  cols: number
  rows: number
}

/** Processus lancé dans un conteneur (`docker exec -it`). */
export interface ExecSession {
  write(data: string | Buffer): void
  resize(cols: number, rows: number): Promise<void>
  /** Sortie du terminal (stdout et stderr confondus, TTY). */
  onData(listener: (chunk: Buffer) => void): void
  pause(): void
  resume(): void
  /** Code de sortie à la fin du processus ; null s'il est inconnu. */
  readonly exited: Promise<number | null>
  /** Coupe la connexion ; le shell reçoit SIGHUP. */
  close(): void
}

/**
 * Accès à un démon Docker. Le cœur de Vercio ne parle qu'à cette interface :
 * V1 : socket local ; plus tard : agent distant.
 */
export interface HostDriver {
  ping(): Promise<boolean>
  info(): Promise<DockerInfo>
  /** Conteneurs d'un projet Compose (label `com.docker.compose.project`), arrêtés compris. */
  listContainers(composeProject: string): Promise<ContainerView[]>
  /** Conteneurs de tous les projets Compose, par projet (vue d'ensemble). */
  composeContainerViews(): Promise<Map<string, ContainerView[]>>
  containerAction(containerId: string, action: ContainerAction): Promise<void>
  /** Diffuse les logs d'un conteneur ; se termine à l'arrêt du conteneur ou sur `signal`. */
  streamLogs(containerId: string, options: LogOptions): Promise<void>
  /** Évènements des conteneurs Compose ; se termine si le flux est coupé ou sur `signal`. */
  watchEvents(options: EventOptions): Promise<void>
  /** Conteneurs de tous les projets Compose, arrêtés compris. */
  composeContainers(): Promise<ContainerState[]>
  inspectContainer(containerId: string): Promise<ContainerState | null>
  /** Tous les conteneurs Compose de l'hôte, labels et montages compris (import de projets). */
  composeInventory(): Promise<ComposeContainer[]>
  /** Tous les conteneurs de l'hôte, gérés ou non par Vercio. */
  hostContainers(): Promise<HostContainerView[]>
  /** Espace récupérable par type de nettoyage (`docker system df`). */
  cleanupPreview(): Promise<CleanupPreview>
  /** Nettoyage d'un type : éléments supprimés et octets récupérés. */
  cleanup(target: CleanupTarget): Promise<{ deleted: number; bytes: number }>
  /** Mesures en continu d'un conteneur ; se termine à son arrêt ou sur `signal`. */
  streamStats(containerId: string, options: StatsOptions): Promise<void>
  /** `docker inspect` lisible ; null si le conteneur n'existe plus. */
  containerDetails(containerId: string): Promise<ContainerDetails | null>
  /** Shell interactif dans un conteneur en marche. */
  exec(containerId: string, options: ExecOptions): Promise<ExecSession>
  /** Réseaux existants parmi `names`, avec leurs conteneurs attachés. */
  networks(names: string[]): Promise<Map<string, NetworkState>>
  /** Supprime un réseau ; `in_use` si des conteneurs y sont encore attachés. */
  removeNetwork(name: string): Promise<'removed' | 'missing' | 'in_use'>
  /**
   * Branche des conteneurs en marche sur un réseau partagé (créé s'il manque), sans attendre
   * leur prochain déploiement ; `aliases` : noms DNS du conteneur sur ce réseau.
   */
  connectNetwork(name: string, containers: { id: string; aliases: string[] }[]): Promise<void>
  /** Conteneur de Vercio lui-même (nom d'hôte du processus) ; null hors conteneur. */
  selfContainer(): Promise<SelfContainer | null>
  /**
   * Lance un conteneur indépendant de Vercio (supprimé à sa fin), image téléchargée au besoin.
   * Sert à la mise à jour de Vercio : le conteneur survit au remplacement de celui de Vercio.
   */
  runDetached(options: DetachedRun): Promise<string>
}

export interface SelfContainer {
  id: string
  image: string
  labels: Record<string, string>
  /** Montages : chemin sur l'hôte → chemin dans le conteneur. */
  mounts: { source: string; destination: string }[]
}

export interface DetachedRun {
  image: string
  command: string[]
  env: Record<string, string>
  /** `hôte:conteneur[:ro]` */
  binds: string[]
  labels: Record<string, string>
}

export interface NetworkState {
  containers: { name: string; project: string | null }[]
}
