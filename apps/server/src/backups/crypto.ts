import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type DecipherGCM,
} from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'

/**
 * Chiffrement des fichiers de sauvegarde (AES-256-GCM, clé dérivée de la phrase par scrypt).
 * Format : `VRCB` · version (1 octet) · sel (16) · IV (12) · données chiffrées · tag (16).
 * Lisible sans Vercio : `vercio decrypt-backup <fichier> <sortie>`.
 */
const MAGIC = Buffer.from('VRCB')
const VERSION = 1
const SALT = 16
const IV = 12
const TAG = 16
const HEADER = MAGIC.length + 1 + SALT + IV

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      salt,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  )
}

export async function encryptStream(passphrase: string): Promise<Transform> {
  const salt = randomBytes(SALT)
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv)
  let started = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!started) {
        started = true
        this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]))
      }
      callback(null, cipher.update(chunk))
    },
    flush(callback) {
      if (!started) this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]))
      this.push(cipher.final())
      callback(null, cipher.getAuthTag())
    },
  })
}

/** Déchiffre au fil de l'eau ; une phrase fausse ou un fichier altéré fait échouer le flux. */
export function decryptStream(passphrase: string): Transform {
  let header: Buffer | null = Buffer.alloc(0)
  let decipher: DecipherGCM | null = null
  // Les 16 derniers octets sont le tag : on les garde de côté jusqu'à la fin.
  let tail = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      void (async () => {
        if (header) {
          header = Buffer.concat([header, chunk])
          if (header.length < HEADER) return callback()
          if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) {
            return callback(new Error('Fichier non chiffré par Vercio ou format inconnu'))
          }
          const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT)
          const iv = header.subarray(MAGIC.length + 1 + SALT, HEADER)
          decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv)
          chunk = header.subarray(HEADER)
          header = null
        }
        const data = Buffer.concat([tail, chunk])
        const cut = Math.max(0, data.length - TAG)
        tail = data.subarray(cut)
        callback(null, decipher!.update(data.subarray(0, cut)))
      })().catch(callback)
    },
    flush(callback) {
      if (!decipher || tail.length !== TAG) {
        return callback(new Error('Fichier chiffré tronqué'))
      }
      decipher.setAuthTag(tail)
      try {
        callback(null, decipher.final())
      } catch {
        callback(new Error('Phrase de chiffrement incorrecte ou fichier altéré'))
      }
    },
  })
}
