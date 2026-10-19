import { z } from 'zod'

// --- Webhooks ---------------------------------------------------------------------------

/** Adresse IP ou plage CIDR, en IPv4 ou IPv6. */
export const ipRuleSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success ||
      z.cidrv4().safeParse(value).success ||
      z.cidrv6().safeParse(value).success,
    { message: 'Adresse IP ou plage CIDR invalide (ex. 10.0.0.0/8)' },
  )

export const ipAllowlistSchema = z.object({
  ipAllowlist: z
    .array(ipRuleSchema)
    .max(200)
    .transform((rules) => [...new Set(rules)]),
})
export type IpAllowlistInput = z.input<typeof ipAllowlistSchema>

/** Réglages globaux ; champ absent : inchangé. */
export const webhookSettingsInputSchema = z.object({
  /** Désactivés : toutes les URL de webhook répondent 404, sans rien déclencher. */
  enabled: z.boolean().optional(),
  ipAllowlist: ipAllowlistSchema.shape.ipAllowlist.optional(),
})
export type WebhookSettingsInput = z.input<typeof webhookSettingsInputSchema>

export type WebhookKind = 'generic' | 'gitlab' | 'github'

/** Résultat du traitement d'un appel de webhook. */
export type WebhookResult =
  /** Nouveau déploiement lancé. */
  | 'deployed'
  /** Un déploiement est déjà en attente : l'appel lui est rattaché. */
  | 'merged'
  /** Les images n'ont pas changé : rien à faire. */
  | 'unchanged'
  /** Appel valide mais sans effet (verrou, autre branche, pipeline en échec…). */
  | 'ignored'
  /** Appel refusé (IP non autorisée, signature invalide). */
  | 'rejected'
  /** Erreur pendant le traitement (registry injoignable…). */
  | 'error'

export interface WebhookResponse {
  result: WebhookResult
  message: string
  deploymentId: string | null
}

export interface WebhookSourceView {
  appSourceId: string
  /** `null` si aucun jeton n'a encore été généré, ou pour un lecteur (rôle viewer). */
  token: string | null
  secret: string | null
  urls: Record<WebhookKind, string> | null
  /** Fournisseur du dépôt : le webhook natif correspondant peut être créé par Vercio. */
  provider: 'gitlab' | 'github'
  /** Webhook créé par Vercio chez le fournisseur, et quand ; null : à créer (ou à recréer). */
  installedAt: string | null
  /** Page des webhooks du dépôt chez le fournisseur. */
  providerHooksUrl: string
}

export interface WebhookEventView {
  id: string
  appSourceId: string | null
  kind: string
  ip: string | null
  result: WebhookResult
  reason: string | null
  /** Résumé de l'appel : évènement, branche, statut du pipeline. */
  details: Record<string, string | null> | null
  deploymentId: string | null
  createdAt: string
}

export interface WebhookConfigView {
  /** Liste propre à l'environnement (vide : la liste globale s'applique). */
  ipAllowlist: string[]
  globalIpAllowlist: string[]
  /** Webhooks désactivés pour toute l'instance (Paramètres → Webhooks). */
  enabled: boolean
  sources: WebhookSourceView[]
  events: WebhookEventView[]
}

export interface WebhookSettings {
  enabled: boolean
  ipAllowlist: string[]
}

// --- Conteneurs -----------------------------------------------------------------------------

export const containerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
  /** Service visé ; absent : tous les conteneurs de l'environnement. */
  service: z.string().min(1).max(100).optional(),
})
export type ContainerActionInput = z.input<typeof containerActionSchema>
export type ContainerAction = ContainerActionInput['action']

export interface ContainerView {
  id: string
  name: string
  service: string
  image: string
  /** created, running, paused, restarting, removing, exited, dead */
  state: string
  /** Texte Docker : « Up 5 minutes (healthy) ». */
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  createdAt: string
  /** Ports publiés, lisibles : « 127.0.0.1:8080→80/tcp » (adresse omise si toutes). */
  ports: string[]
  /** Détail des ports publiés sur l'hôte. */
  published: PublishedPort[]
  /** Réseaux Docker auxquels le conteneur est relié. */
  networks: string[]
  /** Services dont il dépend (`depends_on`, lu dans les labels posés par Compose). */
  dependsOn: string[]
  /** Relais d'un service mis à jour sans coupure : ses ports sont ceux du service. */
  relayFor: string | null
}

export interface PublishedPort {
  /** Adresse d'écoute sur l'hôte ; null : toutes les interfaces (accessible de l'extérieur). */
  ip: string | null
  hostPort: number
  containerPort: number
  protocol: string
}

export interface ContainerLogLine {
  /** Service Compose du conteneur. */
  service: string
  container: string
  stream: 'stdout' | 'stderr'
  /** Horodatage Docker (ISO 8601), si disponible. */
  at: string | null
  line: string
}

/** Évènements du flux de logs (SSE). */
export type ContainerLogEvent =
  | { type: 'log'; log: ContainerLogLine }
  /** Le flux d'un conteneur s'est arrêté (conteneur arrêté ou recréé). */
  | { type: 'end'; container: string }

// --- Statistiques, inspection, terminal ----------------------------------------------------

/** Mesure d'un conteneur. Réseau et disque : cumuls depuis le démarrage (débit = écart). */
export interface ContainerStatsSample {
  at: string
  /** Pourcentage d'un cœur (200 = deux cœurs pleins) ; null sur la première mesure. */
  cpuPercent: number | null
  /** Mémoire utilisée, sans le cache de fichiers (comme `docker stats`). */
  memoryBytes: number
  /** Limite mémoire : celle du conteneur, sinon la mémoire de l'hôte. */
  memoryLimitBytes: number
  netRxBytes: number
  netTxBytes: number
  blockReadBytes: number
  blockWriteBytes: number
  pids: number
}

/** Historique court (en mémoire du serveur) des conteneurs en marche d'un environnement. */
export interface ContainerStatsView {
  id: string
  name: string
  service: string
  /** Du plus ancien au plus récent, une mesure toutes les 5 s, 10 minutes au plus. */
  samples: ContainerStatsSample[]
}

export interface ContainerInspectView {
  id: string
  name: string
  service: string
  image: string
  /** Image résolue (digest), si connue. */
  imageId: string
  createdAt: string
  startedAt: string | null
  state: string
  restartCount: number
  restartPolicy: string
  command: string[]
  entrypoint: string[]
  workingDir: string
  user: string
  /** Valeurs secrètes remplacées par `masked: true` et `value: null`. */
  env: { key: string; value: string | null; masked: boolean }[]
  mounts: {
    type: string
    /** Volume nommé, ou chemin de l'hôte. */
    source: string
    destination: string
    readOnly: boolean
  }[]
  networks: { name: string; ip: string | null; aliases: string[] }[]
  ports: string[]
  labels: Record<string, string>
  health: {
    status: string
    failingStreak: number
    /** Dernières exécutions du healthcheck, de la plus ancienne à la plus récente. */
    log: { start: string; exitCode: number; output: string }[]
  } | null
}

export const TERMINAL_SHELLS = ['auto', 'bash', 'sh', 'ash', 'zsh'] as const
export type TerminalShell = (typeof TERMINAL_SHELLS)[number]

/** Messages du navigateur vers le terminal (WebSocket, texte JSON). */
export type TerminalClientMessage =
  { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }

/** Messages de contrôle du serveur (texte JSON) ; la sortie du shell arrive en binaire. */
export type TerminalServerMessage =
  { type: 'ready' } | { type: 'exit'; code: number | null } | { type: 'error'; message: string }

/** Qui peut ouvrir un terminal : les administrateurs, et les déployeurs si autorisé. */
export const terminalSettingsSchema = z.object({ deployers: z.boolean() })
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>
