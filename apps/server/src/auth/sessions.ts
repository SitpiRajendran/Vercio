import { and, eq, gt, lt } from 'drizzle-orm'
import { roleSchema, type SessionUser } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { sessions, users } from '../db/schema.js'
import { hashToken, randomToken } from '../lib/crypto.js'

export const SESSION_COOKIE = 'vercio_session'

/**
 * Nom du cookie de session. En HTTPS, le préfixe `__Host-` interdit à une application d'un
 * domaine voisin (souvent déployée par Vercio lui-même) d'imposer sa propre session.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
  ) {}

  async create(
    userId: string,
    meta: { ip?: string; userAgent?: string; oidcSid?: string | null; idTokenEnc?: string | null },
  ) {
    const token = randomToken()
    const expiresAt = new Date(Date.now() + this.ttlMs)
    await this.db.insert(sessions).values({
      tokenHash: hashToken(token),
      userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      oidcSid: meta.oidcSid ?? null,
      idTokenEnc: meta.idTokenEnc ?? null,
      expiresAt,
    })
    return { token, expiresAt }
  }

  /** Session brute (pour la déconnexion SSO, qui a besoin de l'ID token). */
  async find(token: string) {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1)
    return row ?? null
  }

  /** Déconnexion back-channel : ferme les sessions d'une session SSO, ou de tout l'utilisateur. */
  async destroyByOidc(target: { sid?: string; userId?: string }): Promise<number> {
    const condition = target.sid
      ? eq(sessions.oidcSid, target.sid)
      : target.userId
        ? eq(sessions.userId, target.userId)
        : null
    if (!condition) return 0
    const deleted = await this.db
      .delete(sessions)
      .where(condition)
      .returning({ t: sessions.tokenHash })
    return deleted.length
  }

  async resolve(token: string): Promise<SessionUser | null> {
    const [row] = await this.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1)
    if (!row || row.user.disabled) return null
    return toSessionUser(row.user)
  }

  async destroy(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
  }
}

export function toSessionUser(user: typeof users.$inferSelect): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    roles: user.roles.flatMap((role) => {
      const parsed = roleSchema.safeParse(role)
      return parsed.success ? [parsed.data] : []
    }),
    provider: user.provider,
  }
}
