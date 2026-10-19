import { parse } from 'yaml'
import type { ComposeAnalysis, ComposeServiceInfo } from '@vercio/shared'
import { zeroDowntimeEligibility } from '../deploy/zero-downtime.js'

type Mapping = Record<string, unknown>

const isMapping = (value: unknown): value is Mapping =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Lecture d'un fichier Compose pour l'interface : services, images, ports et points d'attention.
 * La validation complète (interpolation, schéma) est faite par `docker compose config` au déploiement.
 */
export function analyzeCompose(content: string): ComposeAnalysis {
  let document: unknown
  try {
    document = parse(content, { maxAliasCount: 100 })
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { services: [], error: `YAML invalide : ${message}`, warnings: [] }
  }
  if (!isMapping(document) || !isMapping(document.services)) {
    return { services: [], error: 'Aucune section « services » dans ce fichier', warnings: [] }
  }

  const warnings: string[] = []
  const services: ComposeServiceInfo[] = []
  for (const [name, raw] of Object.entries(document.services)) {
    if (!isMapping(raw)) {
      return { services: [], error: `Service « ${name} » mal défini`, warnings: [] }
    }
    const image = typeof raw.image === 'string' ? raw.image : null
    const hasBuild = raw.build !== undefined
    if (!image && hasBuild) {
      warnings.push(
        `« ${name} » est construit localement (build) sans image : Vercio ne construit pas d’image, publiez-la depuis votre CI.`,
      )
    } else if (!image) {
      return { services: [], error: `Le service « ${name} » n’a pas d’image`, warnings: [] }
    }
    if (raw.container_name !== undefined) {
      warnings.push(
        `« ${name} » fixe container_name : deux environnements du projet ne pourront pas coexister.`,
      )
    }
    if (raw.privileged === true) {
      warnings.push(`« ${name} » est privilégié (privileged) : accès quasi total à l’hôte.`)
    }
    for (const volume of listOf(raw.volumes)) {
      const source =
        typeof volume === 'string' ? volume.split(':')[0] : isMapping(volume) ? volume.source : null
      if (typeof source !== 'string') continue
      if (source.includes('docker.sock')) {
        warnings.push(`« ${name} » monte le socket Docker : accès root à l’hôte.`)
      } else if (source.startsWith('./') || source.startsWith('../')) {
        warnings.push(
          `« ${name} » monte un chemin relatif (${source}) : il sera résolu dans le dossier de l’environnement géré par Vercio.`,
        )
      }
    }
    const hasHealthcheck = isMapping(raw.healthcheck) && raw.healthcheck.disable !== true
    services.push({
      name,
      image,
      hasBuild,
      ports: listOf(raw.ports).map(formatPort),
      hasHealthcheck,
      restart: typeof raw.restart === 'string' ? raw.restart : null,
      networks: Array.isArray(raw.networks)
        ? raw.networks.filter((item): item is string => typeof item === 'string')
        : isMapping(raw.networks)
          ? Object.keys(raw.networks)
          : null,
      networkMode: typeof raw.network_mode === 'string' ? raw.network_mode : null,
      dependsOn: (Array.isArray(raw.depends_on)
        ? raw.depends_on.filter((item): item is string => typeof item === 'string')
        : isMapping(raw.depends_on)
          ? Object.keys(raw.depends_on)
          : []
      ).sort(),
      variables: serviceVariables(raw),
      envFile: raw.env_file !== undefined,
      zeroDowntime: zeroDowntimeEligibility(raw),
    })
  }
  if (services.length === 0) {
    return { services: [], error: 'La section « services » est vide', warnings: [] }
  }
  const variables = new Set(interpolatedVariables(content))
  for (const service of services) for (const name of service.variables) variables.add(name)
  const envFile = services.some((service) => service.envFile)
  return { services, error: null, warnings, variables: [...variables].sort(), envFile }
}

/** Variables d'un service : interpolées dans sa définition, ou transmises par leur nom. */
function serviceVariables(raw: Mapping): string[] {
  const names = new Set(interpolatedVariables(JSON.stringify(raw)))
  // `environment: [NOM]` ou `NOM:` sans valeur : la valeur vient de l'environnement de Compose.
  if (Array.isArray(raw.environment)) {
    for (const item of raw.environment) {
      if (typeof item === 'string' && !item.includes('=')) names.add(item.trim())
    }
  } else if (isMapping(raw.environment)) {
    for (const [key, value] of Object.entries(raw.environment)) {
      if (value === null) names.add(key)
    }
  }
  return [...names].sort()
}

/** Noms interpolés dans le fichier (`${NOM}`, `${NOM:-défaut}`, `$NOM`), hors `$$` échappé. */
export function interpolatedVariables(content: string): string[] {
  const names = new Set<string>()
  for (const match of content.matchAll(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = match[1] ?? match[2]
    if (name) names.add(name)
  }
  return [...names]
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function formatPort(port: unknown): string {
  if (typeof port === 'string' || typeof port === 'number') return String(port)
  if (isMapping(port)) {
    const published = port.published ?? ''
    const target = port.target ?? ''
    return published ? `${published}:${target}` : String(target)
  }
  return '?'
}
