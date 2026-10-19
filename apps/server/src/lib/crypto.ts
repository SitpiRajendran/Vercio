import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  type Hmac,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const FORMAT_VERSION = 'v1'

/**
 * Chiffrement des secrets au repos (tokens, identifiants, variables secrètes).
 * Format : `v1:<iv>:<tag>:<données>` en base64url.
 */
export class SecretBox {
  readonly #key: Buffer

  constructor(secret: string) {
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'vercio', 'vercio:secretbox:v1', 32))
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.#key, iv)
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [FORMAT_VERSION, iv, tag, data].map(encodePart).join(':')
  }

  /** HMAC-SHA256 propre à un usage (clé dérivée, distincte de celle du chiffrement). */
  hmac(purpose: string): Hmac {
    const key = Buffer.from(hkdfSync('sha256', this.#key, '', `vercio:hmac:${purpose}`, 32))
    return createHmac('sha256', key)
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':')
    if (version !== FORMAT_VERSION || !iv || !tag || data === undefined) {
      throw new Error('Format de secret chiffré invalide')
    }
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }
}

function encodePart(part: string | Buffer): string {
  return typeof part === 'string' ? part : part.toString('base64url')
}

/** Jeton aléatoire (sessions, webhooks) : 32 octets en base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Empreinte stockée en base à la place du jeton. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
