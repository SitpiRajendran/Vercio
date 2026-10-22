import { isMap, parseDocument } from 'yaml'
import { COMPOSE_YAML } from '../compose/yaml.js'

/**
 * Mise à jour sans coupure (blue-green) : la nouvelle version d'un service démarre à côté de
 * l'ancienne, l'ancienne s'arrête une fois la nouvelle saine. Les ports publiés du service
 * passent sur un petit relais nginx, qui reste en place et suit le service par son nom DNS.
 */

/** Image du relais : nginx officiel, version figée. */
export const RELAY_IMAGE = 'nginx:1.27-alpine'
export const RELAY_PREFIX = 'vercio-relay-'

export interface PortSpec {
  hostIp: string | null
  /** Port de l'hôte ; null : choisi par Docker. */
  published: number | null
  target: number
}

export interface Eligibility {
  eligible: boolean
  /** Pourquoi la mise à jour sans coupure est impossible. */
  reason: string | null
  /** Possible, mais à savoir (volumes partagés pendant la bascule…). */
  warning: string | null
}

type Mapping = Record<string, unknown>
const isMapping = (value: unknown): value is Mapping =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Ports TCP simples d'un service (`8080:80`, `127.0.0.1:8080:80`, `80`, syntaxe longue).
 * null : une plage, de l'UDP ou une forme non reconnue, que le relais ne sait pas reprendre.
 */
export function parsePortSpecs(ports: unknown): PortSpec[] | null {
  if (ports === undefined || ports === null) return []
  if (!Array.isArray(ports)) return null
  const result: PortSpec[] = []
  for (const port of ports) {
    if (typeof port === 'number') {
      result.push({ hostIp: null, published: null, target: port })
      continue
    }
    if (typeof port === 'string') {
      const [spec, protocol = 'tcp'] = port.split('/')
      if (protocol !== 'tcp' || !spec || spec.includes('-')) return null
      // Adresse IPv6 entre crochets : « [::1]:8080:80 ».
      let hostIp: string | null = null
      let rest = spec
      if (spec.startsWith('[')) {
        const end = spec.indexOf(']:')
        if (end === -1) return null
        hostIp = spec.slice(0, end + 1)
        rest = spec.slice(end + 2)
      }
      const parts = rest.split(':')
      if (hostIp && parts.length !== 2) return null
      if (parts.length === 3) hostIp = parts.shift()!
      if (parts.length > 2 || !parts.every((part) => /^\d+$/.test(part))) return null
      result.push({
        hostIp,
        published: parts.length === 2 ? Number(parts[0]) : null,
        target: Number(parts.at(-1)),
      })
      continue
    }
    if (isMapping(port)) {
      if ((port.protocol ?? 'tcp') !== 'tcp') return null
      const target = Number(port.target)
      const published =
        port.published === undefined || port.published === null ? null : Number(port.published)
      if (!Number.isInteger(target) || (published !== null && !Number.isInteger(published))) {
        return null
      }
      result.push({
        hostIp: typeof port.host_ip === 'string' ? port.host_ip : null,
        published,
        target,
      })
      continue
    }
    return null
  }
  return result
}

/** Forme courte d'un port pour le relais : même adresse et même port d'hôte qu'avant. */
export function formatPortSpec(port: PortSpec): string {
  if (port.published === null) return String(port.target)
  return `${port.hostIp ? `${port.hostIp}:` : ''}${port.published}:${port.target}`
}

/** Un service peut-il être mis à jour sans coupure ? */
export function zeroDowntimeEligibility(service: Mapping): Eligibility {
  const no = (reason: string): Eligibility => ({ eligible: false, reason, warning: null })
  if (typeof service.network_mode === 'string') {
    return no(`network_mode: ${service.network_mode} : deux versions ne peuvent pas coexister`)
  }
  if (service.container_name !== undefined) {
    return no('container_name fixe : deux versions ne peuvent pas porter le même nom')
  }
  if (parsePortSpecs(service.ports) === null) {
    return no('ports non pris en charge par le relais (plage de ports ou UDP)')
  }
  const deploy = isMapping(service.deploy) ? service.deploy : null
  if (deploy && Number(deploy.replicas ?? 1) > 1) {
    return no('plusieurs réplicas (deploy.replicas) : non pris en charge')
  }
  const volumes = Array.isArray(service.volumes) ? service.volumes : []
  const named = volumes.some((volume) => {
    const source =
      typeof volume === 'string'
        ? volume.split(':')[0]
        : isMapping(volume) && typeof volume.source === 'string'
          ? volume.source
          : null
    return Boolean(source && !source.startsWith('/') && !source.startsWith('.'))
  })
  return {
    eligible: true,
    reason: null,
    warning: named
      ? 'Ancienne et nouvelle versions partagent ses volumes pendant quelques secondes : à éviter pour une base de données.'
      : null,
  }
}

export interface Relay {
  /** Service relayé. */
  service: string
  /** Nom du service relais dans le Compose. */
  name: string
  ports: PortSpec[]
  /** Réseaux déclarés par le service (null : `default`), rejoints aussi par le relais. */
  networks: string[] | null
}

export interface ZeroDowntimePlan {
  /** Fichier Compose à déployer : ports des services relayés retirés. */
  compose: string
  /** Services mis à jour sans coupure. */
  services: string[]
  relays: Relay[]
  /** Services demandés mais impossibles, avec la raison. */
  skipped: { service: string; reason: string }[]
}

/**
 * Prépare le fichier Compose : pour chaque service mis à jour sans coupure, ses ports publiés
 * passent au relais (sinon l'ancienne et la nouvelle version se disputeraient le port).
 */
export function planZeroDowntime(compose: string, requested: string[]): ZeroDowntimePlan {
  const plan: ZeroDowntimePlan = { compose, services: [], relays: [], skipped: [] }
  if (!requested.length) return plan
  const document = parseDocument(compose, { merge: true })
  const services = document.get('services')
  if (!isMap(services)) return plan
  const raw = document.toJS({ maxAliasCount: COMPOSE_YAML.maxAliasCount }) as {
    services?: Record<string, Mapping>
  }
  for (const service of requested) {
    const definition = raw.services?.[service]
    if (!definition) {
      plan.skipped.push({ service, reason: 'absent du fichier Compose' })
      continue
    }
    const eligibility = zeroDowntimeEligibility(definition)
    if (!eligibility.eligible) {
      plan.skipped.push({ service, reason: eligibility.reason! })
      continue
    }
    plan.services.push(service)
    const ports = parsePortSpecs(definition.ports) ?? []
    if (!ports.length) continue
    const node = services.get(service, true)
    // Ports hérités par `<<: *commun` : une liste vide explicite les annule.
    if (isMap(node)) {
      if (node.has('ports') && !node.has('<<')) node.delete('ports')
      else node.set('ports', document.createNode([]))
    }
    const networks = Array.isArray(definition.networks)
      ? definition.networks.filter((item): item is string => typeof item === 'string')
      : isMapping(definition.networks)
        ? Object.keys(definition.networks)
        : null
    plan.relays.push({ service, name: `${RELAY_PREFIX}${service}`, ports, networks })
  }
  if (plan.relays.length) plan.compose = document.toString()
  return plan
}

/**
 * Page affichée par le relais quand le service ne répond pas : autonome (aucune ressource
 * externe), claire et sombre, rechargée toutes les 10 s. Sans « ' » ni « $ » : elle est
 * placée telle quelle dans une chaîne nginx.
 */
export const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Site momentanément indisponible</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2129; --muted: #667085; --accent: #3b6cf6; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0f13; --card: #171a21; --text: #eceef2; --muted: #9aa1ad; --accent: #7aa2ff; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
main { max-width: 440px; width: 100%; background: var(--card); border-radius: 16px; padding: 40px 32px; text-align: center; box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
.spinner { width: 40px; height: 40px; margin: 0 auto 24px; border: 3px solid color-mix(in srgb, var(--accent) 20%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
h1 { font-size: 20px; margin: 0 0 8px; }
p { margin: 0; color: var(--muted); }
.en { margin-top: 20px; font-size: 14px; }
</style></head>
<body><main>
<div class="spinner" aria-hidden="true"></div>
<h1>Site momentanément indisponible</h1>
<p>Le service redémarre ou est en cours de mise à jour. Cette page se recharge toute seule.</p>
<p class="en" lang="en">This site is temporarily unavailable and will be back shortly.</p>
</main></body></html>`

/**
 * Configuration nginx du relais : un serveur par port, vers `upstream` résolu à chaque requête
 * par le DNS de Docker. En temps normal, le nom du service ; pendant une bascule, le nom du
 * conteneur de la nouvelle version, pour que plus aucune requête n'aille à l'ancienne.
 */
export function renderRelayConfig(relay: Relay, upstream = relay.service): string {
  const targets = [...new Set(relay.ports.map((port) => port.target))]
  const servers = targets.map(
    (target) => `server {
  listen ${target};
  location / {
    set $vercio_upstream ${upstream};
    proxy_pass http://$vercio_upstream:${target};
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $vercio_connection;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $vercio_proto;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    # Version arrêtée pendant la bascule : la requête repart vers l'autre.
    proxy_next_upstream error timeout http_502;
    proxy_next_upstream_tries 3;
    # Service injoignable (redémarrage, arrêt) : page d'attente au lieu d'un 502. Les erreurs
    # renvoyées par l'application elle-même passent telles quelles.
    error_page 502 503 504 = @vercio_down;
  }
  location @vercio_down {
    default_type text/html;
    add_header Cache-Control "no-store" always;
    add_header Retry-After "10" always;
    return 503 '${UNAVAILABLE_PAGE}';
  }
}`,
  )
  return `# Généré par Vercio : relais du service ${relay.service}.
resolver 127.0.0.11 valid=1s ipv6=off;
map $http_upgrade $vercio_connection {
  default upgrade;
  '' '';
}
map $http_x_forwarded_proto $vercio_proto {
  default $http_x_forwarded_proto;
  '' $scheme;
}
${servers.join('\n')}
`
}

/** Sortie de `docker inspect` : la nouvelle version est-elle prête ? */
export function readiness(
  status: string,
  health: string,
): 'ready' | 'waiting' | 'failed' | 'running' {
  if (status === 'exited' || status === 'dead' || health === 'unhealthy') return 'failed'
  if (status !== 'running') return 'waiting'
  if (health === 'healthy') return 'ready'
  if (health === 'starting') return 'waiting'
  // Sans healthcheck : en marche, à confirmer après quelques secondes.
  return 'running'
}
