import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  currentTimeStep,
  generateTotpSecret,
  totpCode,
  totpUri,
  verifyTotp,
} from '../src/lib/totp.js'

// Secret des vecteurs de test de la RFC 6238 (« 12345678901234567890 » en ASCII).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP', () => {
  it('respecte les vecteurs de la RFC 6238 (SHA-1, 6 chiffres)', () => {
    const cases: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, code] of cases) {
      expect(totpCode(RFC_SECRET, currentTimeStep(seconds * 1000))).toBe(code)
    }
  })

  it('encode et décode le base32', () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Encode(base32Decode(secret))).toBe(secret)
  })

  it('accepte le code courant et un pas de décalage', () => {
    const now = 1_700_000_000_000
    const step = currentTimeStep(now)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { now })).toBe(step)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { now })).toBe(step - 1)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 3), { now })).toBeNull()
  })

  it('refuse la réutilisation d’un code', () => {
    const now = 1_700_000_000_000
    const step = currentTimeStep(now)
    const code = totpCode(RFC_SECRET, step)
    expect(verifyTotp(RFC_SECRET, code, { now, lastUsedStep: step })).toBeNull()
  })

  it('refuse les codes mal formés', () => {
    expect(verifyTotp(RFC_SECRET, '12345')).toBeNull()
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBeNull()
  })

  it('construit une URI otpauth', () => {
    const uri = totpUri('ABC', 'admin')
    expect(uri.startsWith('otpauth://totp/Vercio%3Aadmin?')).toBe(true)
    expect(uri).toContain('secret=ABC')
  })
})
