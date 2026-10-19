import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

/** Mot de passe temporaire remis à un utilisateur (création, réinitialisation). */
export function temporaryPassword(): string {
  // Sans caractères ambigus (0/O, 1/l/I) : il est souvent recopié à la main.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('')
}
