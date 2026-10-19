import dns from 'node:dns'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent, type Dispatcher } from 'undici'
import { normalizeIp } from '../lib/ip.js'

export class OutboundUrlError extends Error {
  constructor(
    message: string,
    /** Erreur de configuration : réessayer ne changera rien. */
    readonly permanent = true,
  ) {
    super(message)
  }
}

/**
 * Adresses jamais visées par un webhook : bouclage (Vercio lui-même, socket Docker exposé en TCP),
 * lien-local (métadonnées cloud 169.254.169.254), adresses non routables et multicast.
 * Les plages privées (RFC 1918) restent permises : un récepteur sur le réseau local est légitime.
 */
const FORBIDDEN = new BlockList()
FORBIDDEN.addSubnet('0.0.0.0', 8, 'ipv4')
FORBIDDEN.addSubnet('127.0.0.0', 8, 'ipv4')
FORBIDDEN.addSubnet('169.254.0.0', 16, 'ipv4')
FORBIDDEN.addSubnet('224.0.0.0', 4, 'ipv4')
FORBIDDEN.addSubnet('240.0.0.0', 4, 'ipv4')
FORBIDDEN.addAddress('::', 'ipv6')
FORBIDDEN.addAddress('::1', 'ipv6')
FORBIDDEN.addSubnet('fe80::', 10, 'ipv6')
FORBIDDEN.addSubnet('ff00::', 8, 'ipv6')

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

function forbidden(address: string, allowLoopback: boolean): boolean {
  const ip = normalizeIp(address)
  const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4'
  if (allowLoopback && LOOPBACK.check(ip, type)) return false
  return FORBIDDEN.check(ip, type)
}

export interface OutboundOptions {
  /** HTTP non chiffré accepté (case cochée par l'admin). */
  allowHttp?: boolean
  /** Tests et développement uniquement : récepteur sur la machine de Vercio. */
  allowLoopback?: boolean
}

/**
 * Vérifie l'URL d'un webhook sortant ou d'un workflow Teams, à l'enregistrement, au test et à
 * chaque envoi (le DNS peut changer entre-temps).
 */
export async function assertOutboundUrl(url: string, options: OutboundOptions = {}): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new OutboundUrlError('URL invalide')
  }
  if (parsed.protocol === 'http:' && !options.allowHttp) {
    throw new OutboundUrlError(
      'HTTPS obligatoire (cochez « HTTP non chiffré » pour un récepteur interne)',
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OutboundUrlError('URL http(s) attendue')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
    } catch {
      // Derrière un proxy d'entreprise, seul le proxy sait résoudre les noms externes.
      if (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY) return
      // Une panne DNS peut être passagère : l'envoi sera réessayé.
      throw new OutboundUrlError('Hôte introuvable (DNS)', false)
    }
  }
  if (addresses.some((address) => forbidden(address, options.allowLoopback ?? false))) {
    throw new OutboundUrlError(
      'Adresse interdite : la machine de Vercio, une adresse lien-local (métadonnées cloud) ou non routable',
    )
  }
}

/** Origine seule (`https://hôte/…`) : l'URL complète peut contenir une signature ou un jeton. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' && !parsed.search ? '' : '/…'}`
  } catch {
    return '(URL invalide)'
  }
}

/** Retire des messages d'erreur les URL complètes (signature `sig=` de Teams, jetons). */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match))
}

const guarded = new Map<boolean, Dispatcher>()

/**
 * Agent qui revérifie l'adresse au moment de la connexion : un nom à durée de vie nulle ne peut
 * pas passer le contrôle puis pointer vers 127.0.0.1 ou 169.254.169.254 (DNS rebinding).
 * Sans effet derrière un proxy d'entreprise, qui seul résout les noms.
 */
export function outboundDispatcher(allowLoopback = false): Dispatcher | undefined {
  if (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY) return undefined
  let agent = guarded.get(allowLoopback)
  if (!agent) {
    const checked: LookupFunction = (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, '', 4)
        const list = addresses as dns.LookupAddress[]
        if (list.some((entry) => forbidden(entry.address, allowLoopback))) {
          return callback(
            Object.assign(new Error('Adresse interdite (bouclage, lien-local ou non routable)'), {
              code: 'EFORBIDDEN',
            }),
            '',
            4,
          )
        }
        if ((options as { all?: boolean }).all) {
          return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
        }
        callback(null, list[0]!.address, list[0]!.family)
      })
    }
    agent = new Agent({ connect: { lookup: checked } })
    guarded.set(allowLoopback, agent)
  }
  return agent
}
