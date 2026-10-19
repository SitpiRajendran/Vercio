import type { FastifyReply, FastifyRequest } from 'fastify'
import type { SecretBox } from '../lib/crypto.js'

/**
 * Cookie court terme, chiffré et authentifié (AES-GCM) : état d'un parcours de connexion
 * (paramètres OIDC en cours, étape de double authentification). Jamais lisible ni falsifiable
 * par le navigateur.
 */
export class SealedCookie<T extends object> {
  constructor(
    private readonly name: string,
    private readonly box: SecretBox,
    private readonly ttlSeconds: number,
    private readonly secure: boolean,
    private readonly path = '/api/auth',
  ) {}

  set(reply: FastifyReply, value: T): void {
    const payload = { v: value, exp: Date.now() + this.ttlSeconds * 1000, n: this.name }
    reply.setCookie(this.name, this.box.encrypt(JSON.stringify(payload)), {
      path: this.path,
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      maxAge: this.ttlSeconds,
    })
  }

  get(request: FastifyRequest): T | null {
    const raw = request.cookies[this.name]
    if (!raw) return null
    try {
      const payload = JSON.parse(this.box.decrypt(raw)) as { v: T; exp: number; n: string }
      // Le nom est inclus dans le chiffré : un cookie ne peut pas être rejoué sous un autre nom.
      if (payload.n !== this.name || payload.exp < Date.now()) return null
      return payload.v
    } catch {
      return null
    }
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(this.name, { path: this.path })
  }
}
