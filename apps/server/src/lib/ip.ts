import { BlockList, isIP } from 'node:net'

/** Adresse IPv4 transmise en IPv6 (`::ffff:10.0.0.1`) : ramenée à sa forme IPv4. */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  return mapped ? mapped[1]! : ip
}

/**
 * Vérifie qu'une adresse appartient à une liste d'IP / plages CIDR.
 * Une liste vide autorise toutes les adresses.
 */
export function ipAllowed(ip: string, rules: string[]): boolean {
  if (rules.length === 0) return true
  const address = normalizeIp(ip)
  const family = isIP(address)
  if (!family) return false
  const list = new BlockList()
  for (const rule of rules) {
    const [base, prefix] = rule.split('/')
    const type = isIP(base!) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(base!, type)
    else list.addSubnet(base!, Number(prefix), type)
  }
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4')
}
