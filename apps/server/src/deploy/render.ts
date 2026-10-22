import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { CommandRunner } from './command.js'
import { parse, stringify } from 'yaml'
import { RELAY_IMAGE } from './zero-downtime.js'
import { COMPOSE_YAML } from '../compose/yaml.js'

export interface OverrideInput {
  projectSlug: string
  environmentSlug: string
  deploymentId: string
  /** Tous les services du fichier Compose. */
  services: string[]
  /** Images épinglées des services suivis : `{ front: "hôte/chemin@sha256:…" }`. */
  images: Record<string, string>
  /** Politique de redémarrage de l'environnement (`no` : rien n'est ajouté). */
  restartPolicy?: string
  /** Services qui fixent déjà leur `restart` dans le fichier Compose : leur choix est gardé. */
  ownRestart?: string[]
  /** Volumes du fichier Compose → volumes Docker existants (projet repris : aucune copie). */
  volumes?: Record<string, string>
  /** Réseaux partagés (externes) rejoints par certains services. */
  sharedNetworks?: {
    /** Réseau Docker, aussi utilisé comme clé dans le fichier Compose. */
    name: string
    /** Service → alias DNS sur ce réseau (vide : nom du service seulement). */
    services: Record<string, string[]>
  }[]
  /** Services qui déclarent leurs réseaux : sans cela, ils sont sur `default` implicitement. */
  explicitNetworks?: string[]
  /**
   * Variables transmises à tous les services, par leur nom seulement : la valeur vient de
   * l'environnement de `docker compose` et n'est jamais écrite dans le fichier.
   */
  passVariables?: string[]
  /** Relais nginx des services mis à jour sans coupure (ports publiés repris du service). */
  relays?: { name: string; service: string; ports: string[]; networks: string[] | null }[]
}

/** Fichier de configuration du relais, relatif au dossier de l'environnement. */
export const relayConfigPath = (name: string) => `.vercio/${name}.conf`

/**
 * Surcharge Compose générée par Vercio : images des services suivis épinglées par digest
 * (le déploiement est reproductible même si le tag est déplacé) et labels d'inventaire.
 */
export function renderOverride(input: OverrideInput): string {
  const services: Record<string, unknown> = {}
  for (const name of input.services) {
    services[name] = {
      ...(input.images[name] ? { image: input.images[name] } : {}),
      ...(input.passVariables?.length ? { environment: [...input.passVariables] } : {}),
      ...(input.restartPolicy && input.restartPolicy !== 'no' && !input.ownRestart?.includes(name)
        ? { restart: input.restartPolicy }
        : {}),
      labels: {
        'vercio.managed': 'true',
        'vercio.project': input.projectSlug,
        'vercio.environment': input.environmentSlug,
        'vercio.deployment': input.deploymentId,
      },
    }
  }
  for (const relay of input.relays ?? []) {
    services[relay.name] = {
      image: RELAY_IMAGE,
      pull_policy: 'missing',
      ports: relay.ports,
      volumes: [`./${relayConfigPath(relay.name)}:/etc/nginx/conf.d/default.conf:ro`],
      ...(relay.networks ? { networks: relay.networks } : {}),
      restart:
        input.restartPolicy && input.restartPolicy !== 'no'
          ? input.restartPolicy
          : 'unless-stopped',
      labels: {
        'vercio.managed': 'true',
        'vercio.project': input.projectSlug,
        'vercio.environment': input.environmentSlug,
        // Pas de label de déploiement : le relais n'est jamais recréé d'un déploiement à l'autre.
        'vercio.relay-for': relay.service,
      },
    }
  }
  const volumes = Object.fromEntries(
    Object.entries(input.volumes ?? {}).map(([key, name]) => [key, { name, external: true }]),
  )
  const networks: Record<string, { name: string; external: true }> = {}
  for (const network of input.sharedNetworks ?? []) {
    networks[network.name] = { name: network.name, external: true }
    for (const [service, aliases] of Object.entries(network.services)) {
      const entry = services[service] as { networks?: Record<string, unknown> } | undefined
      if (!entry) continue
      // Déclarer un réseau retire le réseau `default` implicite : il est remis explicitement.
      entry.networks ??= input.explicitNetworks?.includes(service) ? {} : { default: {} }
      entry.networks[network.name] = aliases.length ? { aliases } : {}
    }
  }
  return `# Généré par Vercio : ne pas modifier.\n${stringify({
    services,
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(Object.keys(networks).length ? { networks } : {}),
  })}`
}

/** Hôte d'un registry tel que l'attend Docker (sans schéma ni barre finale). */
export function registryHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/**
 * Configuration Docker propre au déploiement (`DOCKER_CONFIG`) : identifiants des registries
 * utilisés, sans toucher à la configuration de l'hôte.
 */
export function renderDockerConfig(
  credentials: { host: string; username: string; password: string }[],
  /**
   * Dossiers de plugins (docker compose) à conserver : avec un DOCKER_CONFIG temporaire, Docker
   * ne cherche plus dans ~/.docker/cli-plugins, où Docker Desktop installe Compose.
   */
  pluginDirs: string[] = [],
): string {
  const auths: Record<string, { auth: string }> = {}
  for (const { host, username, password } of credentials) {
    auths[host] = { auth: Buffer.from(`${username}:${password}`).toString('base64') }
  }
  return JSON.stringify(
    { auths, ...(pluginDirs.length ? { cliPluginsExtraDirs: pluginDirs } : {}) },
    null,
    2,
  )
}

/**
 * Dossiers des plugins Docker (compose, buildx) tels que les voit la CLI avec la configuration
 * normale de l'utilisateur : réponse exacte, quel que soit l'emplacement d'installation.
 */
export async function detectPluginDirs(runner: CommandRunner): Promise<string[]> {
  const output: string[] = []
  try {
    await runner.run('docker', ['info', '--format', '{{json .ClientInfo.Plugins}}'], {
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
      onLine: (line, stream) => stream === 'stdout' && output.push(line),
      timeoutMs: 15_000,
    })
    const plugins = JSON.parse(output.join('')) as { Path?: string }[] | null
    return [
      ...new Set((plugins ?? []).flatMap((plugin) => (plugin.Path ? [dirname(plugin.Path)] : []))),
    ]
  } catch {
    return []
  }
}

/** Dossiers de plugins Docker hors emplacements système (Docker Desktop, Homebrew…). */
export function dockerPluginDirs(
  env: { DOCKER_CONFIG?: string } = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return [
    join(env.DOCKER_CONFIG ?? join(home, '.docker'), 'cli-plugins'),
    '/Applications/Docker.app/Contents/Resources/cli-plugins',
    '/opt/homebrew/lib/docker/cli-plugins',
    '/usr/local/lib/docker/cli-plugins',
  ].filter((dir) => exists(dir))
}

/** Remplace les valeurs secrètes dans une ligne de journal. */
export function maskSecrets(line: string, secrets: string[]): string {
  let masked = line
  for (const secret of secrets) {
    if (secret.length < 4) continue
    // Aussi sous ses formes courantes : dans une URL (DSN) ou encodé en base64.
    const forms = new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    ])
    for (const form of forms) masked = masked.split(form).join('••••••')
  }
  return masked
}

/**
 * Fichiers `env_file` relatifs du Compose (`.env`, `config/app.env`…). Vercio transmet les variables
 * par l'environnement, sans fichier : ces fichiers sont écrits le temps du déploiement.
 * Les chemins absolus ou sortant du dossier de l'environnement désignent des fichiers de l'hôte.
 */
export function envFilePaths(compose: string): string[] {
  let document: unknown
  try {
    document = parse(compose, COMPOSE_YAML)
  } catch {
    return []
  }
  const services = (document as { services?: Record<string, unknown> } | null)?.services
  const paths = new Set<string>()
  for (const service of Object.values(services ?? {})) {
    const value = (service as { env_file?: unknown } | null)?.env_file
    for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
      const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path
      if (typeof path !== 'string' || !path || isAbsolute(path)) continue
      const normalized = normalize(path)
      if (normalized.startsWith('..')) continue
      paths.add(normalized)
    }
  }
  return [...paths]
}

/** Fichier au format env de Compose ; les valeurs sont prises littéralement (pas d'interpolation). */
export function renderEnvFile(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => {
      if (!value.includes("'") && !/[\r\n]/.test(value)) return `${key}='${value}'`
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
      return `${key}="${escaped}"`
    })
    .join('\n')
    .concat('\n')
}
