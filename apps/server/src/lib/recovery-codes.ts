import { createHash, randomInt } from 'node:crypto'
import { RECOVERY_CODE_COUNT } from '@vercio/shared'

/** Sans caractères ambigus (0/o, 1/l/i) : se recopie sans erreur depuis un papier. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const LENGTH = 10

/** `abcde-fghij` : environ 50 bits d'entropie, avec la limite d'essais du compte. */
export function generateRecoveryCode(): string {
  let code = ''
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateRecoveryCode)
}

/** Haché d'un code saisi : casse, espaces et tirets ignorés. */
export function hashRecoveryCode(input: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, '')
  return createHash('sha256').update(`vercio-recovery:${normalized}`).digest('hex')
}
