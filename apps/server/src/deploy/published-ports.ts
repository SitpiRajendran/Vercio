import { isMap, isSeq, parse, parseDocument } from 'yaml'
import type { PublishedPortRule } from '@vercio/shared'
import { RELAY_PREFIX, type Relay } from './zero-downtime.js'
import { COMPOSE_YAML } from '../compose/yaml.js'

/**
 * Ajoute au fichier Compose les ports ouverts par Vercio (`8080:3700/tcp`, toutes les interfaces
 * de l'hôte), à la suite des ports du service. Fait avant la préparation des mises à jour sans
 * coupure : un service relayé passe ces ports à son relais comme les autres.
 */
export function addPublishedPorts(
  compose: string,
  rules: PublishedPortRule[],
): { compose: string; skipped: { rule: PublishedPortRule; reason: string }[] } {
  const skipped: { rule: PublishedPortRule; reason: string }[] = []
  if (!rules.length) return { compose, skipped }
  const document = parseDocument(compose, { merge: true })
  const services = document.get('services')
  if (!isMap(services)) return { compose, skipped }
  // Valeurs résolues, clés de fusion (`<<: *commun`) comprises.
  const resolved = (
    document.toJS({ maxAliasCount: COMPOSE_YAML.maxAliasCount }) as {
      services?: Record<string, { network_mode?: unknown; ports?: unknown }>
    }
  ).services
  for (const rule of rules) {
    const service = services.get(rule.service, true)
    if (!isMap(service)) {
      skipped.push({ rule, reason: 'service absent du fichier Compose' })
      continue
    }
    if (resolved?.[rule.service]?.network_mode !== undefined) {
      skipped.push({ rule, reason: 'network_mode : le service ne publie pas de port' })
      continue
    }
    const spec = `${rule.published}:${rule.target}${rule.protocol === 'udp' ? '/udp' : ''}`
    const ports = service.get('ports', true)
    if (isSeq(ports)) ports.add(document.createNode(spec))
    else {
      // Ports hérités par fusion : repris, puisque la clé du service les remplace.
      const inherited = resolved?.[rule.service]?.ports
      service.set(
        'ports',
        document.createNode([...(Array.isArray(inherited) ? inherited : []), spec]),
      )
    }
  }
  return { compose: document.toString(), skipped }
}

/** Port servi par un relais avec page d'attente (site ou API HTTP), plutôt que publié directement. */
export const withPage = (rule: PublishedPortRule) => rule.page && rule.protocol === 'tcp'

/** Préfixe des relais qui tiennent un port avec page d'attente (services sans mise à jour sans coupure). */
export const PAGE_RELAY_PREFIX = 'vercio-page-'

/**
 * Ports avec page d'attente : repris par le relais de mise à jour sans coupure du service s'il en
 * a un, sinon par un relais dédié (nginx) qui tient le port même quand le service redémarre.
 */
export function pageRelays(
  compose: string,
  rules: PublishedPortRule[],
  zero: { services: string[]; relays: Relay[] },
): Relay[] {
  const raw = parse(compose, COMPOSE_YAML) as {
    services?: Record<string, { networks?: unknown }>
  } | null
  const relays: Relay[] = []
  for (const rule of rules.filter(withPage)) {
    const definition = raw?.services?.[rule.service]
    if (!definition) continue
    const port = { hostIp: null, published: rule.published, target: rule.target }
    const networks = Array.isArray(definition.networks)
      ? definition.networks.filter((item): item is string => typeof item === 'string')
      : definition.networks && typeof definition.networks === 'object'
        ? Object.keys(definition.networks)
        : null
    if (zero.services.includes(rule.service)) {
      let relay = zero.relays.find((item) => item.service === rule.service)
      if (!relay) {
        relay = {
          service: rule.service,
          name: `${RELAY_PREFIX}${rule.service}`,
          ports: [],
          networks,
        }
        zero.relays.push(relay)
      }
      relay.ports.push(port)
      continue
    }
    let relay = relays.find((item) => item.service === rule.service)
    if (!relay) {
      relay = {
        service: rule.service,
        name: `${PAGE_RELAY_PREFIX}${rule.service}`,
        ports: [],
        networks,
      }
      relays.push(relay)
    }
    relay.ports.push(port)
  }
  return relays
}
