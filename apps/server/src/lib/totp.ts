import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** TOTP (RFC 6238) : SHA-1, 6 chiffres, pas de 30 s — le format attendu par toutes les applis. */
const PERIOD_SECONDS = 30
const DIGITS = 6
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function currentTimeStep(now = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD_SECONDS)
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * Vérifie un code en tolérant un pas de décalage d'horloge.
 * Renvoie le pas accepté (à mémoriser pour refuser la réutilisation d'un code), ou `null`.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const step = currentTimeStep(options.now)
  for (const candidate of [step, step - 1, step + 1]) {
    if (options.lastUsedStep != null && candidate <= options.lastUsedStep) continue
    const expected = Buffer.from(totpCode(secret, candidate))
    if (timingSafeEqual(expected, Buffer.from(code))) return candidate
  }
  return null
}

export function totpUri(secret: string, account: string, issuer = 'Vercio'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error('Secret TOTP invalide')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}
