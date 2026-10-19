import { describe, expect, it } from 'vitest'
import { ipAllowed, normalizeIp } from '../src/lib/ip.js'

describe('Liste d’IP autorisées', () => {
  it('autorise tout quand la liste est vide', () => {
    expect(ipAllowed('198.51.100.1', [])).toBe(true)
  })

  it('reconnaît adresses, plages IPv4 et IPv6, et adresses IPv4 transmises en IPv6', () => {
    const rules = ['10.0.0.0/8', '192.0.2.7', '2001:db8::/32']
    expect(ipAllowed('10.20.30.40', rules)).toBe(true)
    expect(ipAllowed('::ffff:10.20.30.40', rules)).toBe(true)
    expect(ipAllowed('192.0.2.7', rules)).toBe(true)
    expect(ipAllowed('192.0.2.8', rules)).toBe(false)
    expect(ipAllowed('2001:db8:1::5', rules)).toBe(true)
    expect(ipAllowed('2001:db9::5', rules)).toBe(false)
    expect(ipAllowed('pas-une-ip', rules)).toBe(false)
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
  })
})
