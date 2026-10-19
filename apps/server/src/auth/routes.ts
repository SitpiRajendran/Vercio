import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import QRCode from 'qrcode'
import {
  changePasswordSchema,
  firstRunSchema,
  initialPasswordSchema,
  localLoginSchema,
  totpCodeSchema,
  type AuthConfig,
  type LocalLoginResult,
  type LogoutResult,
  type SsoError,
  type TotpSetup,
  type TotpVerifyResult,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import { sessions as sessionsTable, users } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { hashToken, randomToken, type SecretBox } from '../lib/crypto.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { generateTotpSecret, totpUri, verifyTotp } from '../lib/totp.js'
import type { OidcService, PendingLogin } from './oidc.js'
import { SealedCookie } from './sealed-cookie.js'
import { sessionCookieName, type SessionStore } from './sessions.js'

export interface AuthRoutesOptions {
  db: Database
  sessions: SessionStore
  box: SecretBox
  publicUrl: URL
  localEnabled: boolean
  /** Code de la page de premier lancement (voir bootstrap.setupCode). */
  setupCode: string
  oidc: OidcService | null
  oidcProviderName: string
}

/**
 * Étape intermédiaire d'une connexion locale : mot de passe validé, code TOTP attendu
 * (`verify`, `setup`), puis éventuellement mot de passe temporaire à remplacer (`password`).
 */
interface MfaTicket {
  userId: string
  stage: 'verify' | 'setup' | 'password'
  /** Secret en cours d'enrôlement (stage `setup`), confirmé par le premier code valide. */
  pendingSecret?: string
}

/** Compare deux chaînes en temps constant. */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

const LOGIN_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } }

/**
 * Codes TOTP invalides par compte, toutes adresses confondues : au-delà de 5 en 15 minutes, le
 * compte est bloqué 15 minutes (la limite par adresse IP ne suffit pas contre un botnet).
 */
const TOTP_MAX_FAILURES = 5
const TOTP_LOCK_MS = 15 * 60_000
const totpFailures = new Map<string, { count: number; since: number }>()

export function totpLocked(userId: string): boolean {
  const entry = totpFailures.get(userId)
  if (!entry) return false
  if (Date.now() - entry.since > TOTP_LOCK_MS) {
    totpFailures.delete(userId)
    return false
  }
  return entry.count >= TOTP_MAX_FAILURES
}

export function totpFailed(userId: string): void {
  const entry = totpFailures.get(userId)
  if (!entry || Date.now() - entry.since > TOTP_LOCK_MS) {
    totpFailures.set(userId, { count: 1, since: Date.now() })
  } else {
    entry.count++
  }
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const { db, sessions, box, publicUrl, localEnabled, setupCode, oidc, oidcProviderName } = opts
  const secure = publicUrl.protocol === 'https:'
  const sessionCookie = sessionCookieName(secure)
  // `__Secure-` en HTTPS : le navigateur refuse qu'un domaine voisin pose ces cookies.
  const prefix = secure ? '__Secure-' : ''
  const mfaCookie = new SealedCookie<MfaTicket>(`${prefix}vercio_mfa`, box, 5 * 60, secure)
  const oidcCookie = new SealedCookie<PendingLogin>(`${prefix}vercio_oidc`, box, 10 * 60, secure)
  // Haché factice : garde un temps de réponse constant quand l'utilisateur n'existe pas.
  const dummyHash = hashPassword(randomToken())

  async function openSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: { id: string; username: string },
    sso?: { sid: string | null; idToken: string },
  ) {
    const session = await sessions.create(user.id, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      oidcSid: sso?.sid ?? null,
      idTokenEnc: sso ? box.encrypt(sso.idToken) : null,
    })
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: sso ? 'auth.login.sso' : 'auth.login',
      ip: request.ip,
      success: true,
    })
    reply.setCookie(sessionCookie, session.token, {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      expires: session.expiresAt,
    })
  }

  async function noLocalAccount(executor: Pick<Database, 'select'> = db) {
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.provider, 'local'))
      .limit(1)
    return !row
  }

  app.get('/config', async (): Promise<AuthConfig> => ({
    localEnabled,
    setupRequired: localEnabled && (await noLocalAccount()),
    oidcEnabled: oidc !== null,
    oidcProviderName: oidc ? oidcProviderName : null,
  }))

  // --- Premier lancement : création du premier administrateur -------------------------------

  app.post('/setup', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!localEnabled) return reply.code(404).send({ error: 'Connexion locale désactivée' })
    const parsed = firstRunSchema.safeParse(request.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue?.message, field: issue?.path.join('.') })
    }
    const input = parsed.data
    if (!safeEqual(input.setupCode, setupCode)) {
      await audit(db, { action: 'auth.setup', ip: request.ip, success: false })
      return reply.code(401).send({ error: 'Code d’installation incorrect', field: 'setupCode' })
    }
    const passwordHash = await hashPassword(input.password)
    // Verrou : deux formulaires envoyés en même temps ne créent pas deux administrateurs.
    const user = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('vercio:first-run'))`)
      if (!(await noLocalAccount(tx))) return null
      const [created] = await tx
        .insert(users)
        .values({
          provider: 'local',
          subject: input.username,
          username: input.username,
          displayName: input.username,
          email: input.email,
          passwordHash,
          roles: ['vercio-admin'],
        })
        .returning()
      return created ?? null
    })
    if (!user) {
      return reply.code(409).send({ error: 'Vercio est déjà installé : connectez-vous' })
    }
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.setup',
      ip: request.ip,
      success: true,
    })
    // Dernière étape : la double authentification, comme pour tout compte local.
    mfaCookie.set(reply, { userId: user.id, stage: 'setup' })
    const result: LocalLoginResult = { next: 'totp_setup' }
    return result
  })

  app.get('/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Authentification requise' })
    return request.user
  })

  // --- Compte local : mot de passe puis TOTP obligatoire -------------------------------

  app.post('/login', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!localEnabled) return reply.code(404).send({ error: 'Connexion locale désactivée' })
    const parsed = localLoginSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Requête invalide' })
    const { username, password } = parsed.data

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.provider, 'local'), eq(users.subject, username)))
      .limit(1)

    const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash), password)
    if (!user || !valid || user.disabled) {
      await audit(db, { username, action: 'auth.login', ip: request.ip, success: false })
      return reply.code(401).send({ error: 'Identifiants invalides' })
    }

    const stage = user.totpSecretEnc ? 'verify' : 'setup'
    mfaCookie.set(reply, { userId: user.id, stage })
    const result: LocalLoginResult = { next: stage === 'verify' ? 'totp' : 'totp_setup' }
    return result
  })

  app.post('/totp/setup', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const ticket = mfaCookie.get(request)
    if (!ticket || ticket.stage !== 'setup') {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    const [user] = await db.select().from(users).where(eq(users.id, ticket.userId)).limit(1)
    if (!user) return reply.code(401).send({ error: 'Session de connexion expirée' })

    const secret = generateTotpSecret()
    mfaCookie.set(reply, { ...ticket, pendingSecret: secret })
    const uri = totpUri(secret, user.username)
    const result: TotpSetup = {
      secret,
      uri,
      qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1 }),
    }
    return result
  })

  app.post('/totp/verify', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const ticket = mfaCookie.get(request)
    if (!ticket || ticket.stage === 'password') {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    const parsed = totpCodeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Code à 6 chiffres attendu' })

    const [user] = await db.select().from(users).where(eq(users.id, ticket.userId)).limit(1)
    if (!user || user.disabled)
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    if (totpLocked(user.id)) {
      return reply
        .code(429)
        .send({ error: 'Trop de codes invalides : réessayez dans quelques minutes' })
    }

    const secret =
      ticket.stage === 'setup'
        ? ticket.pendingSecret
        : user.totpSecretEnc
          ? box.decrypt(user.totpSecretEnc)
          : undefined
    if (!secret) return reply.code(400).send({ error: 'Enrôlement TOTP non démarré' })

    const step = verifyTotp(secret, parsed.data.code, { lastUsedStep: user.totpLastStep })
    if (step === null) {
      totpFailed(user.id)
      await audit(db, {
        userId: user.id,
        username: user.username,
        action: 'auth.totp',
        ip: request.ip,
        success: false,
      })
      return reply.code(401).send({ error: 'Code invalide' })
    }

    // Mise à jour conditionnelle : deux requêtes simultanées avec le même code (relais de
    // phishing) ne peuvent pas ouvrir deux sessions.
    const [accepted] = await db
      .update(users)
      .set({
        totpLastStep: step,
        ...(ticket.stage === 'setup' ? { totpSecretEnc: box.encrypt(secret) } : {}),
      })
      .where(
        and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
      )
      .returning({ id: users.id })
    if (!accepted) return reply.code(401).send({ error: 'Code invalide' })
    totpFailures.delete(user.id)
    if (ticket.stage === 'setup') {
      await audit(db, {
        userId: user.id,
        username: user.username,
        action: 'auth.totp.enroll',
        ip: request.ip,
        success: true,
      })
    }

    // Mot de passe temporaire : la session n'est ouverte qu'une fois remplacé.
    if (user.passwordChangeRequired) {
      mfaCookie.set(reply, { userId: user.id, stage: 'password' })
      const result: TotpVerifyResult = { next: 'password_change' }
      return result
    }
    mfaCookie.clear(reply)
    await openSession(request, reply, user)
    const result: TotpVerifyResult = { next: 'done' }
    return result
  })

  app.post('/password/initial', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const ticket = mfaCookie.get(request)
    if (!ticket || ticket.stage !== 'password') {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    const parsed = initialPasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message, field: 'password' })
    }
    const [user] = await db.select().from(users).where(eq(users.id, ticket.userId)).limit(1)
    if (!user || user.disabled || !user.passwordHash) {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    if (await verifyPassword(user.passwordHash, parsed.data.password)) {
      return reply.code(400).send({
        error: 'Choisissez un mot de passe différent du mot de passe temporaire',
        field: 'password',
      })
    }
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(parsed.data.password),
        passwordChangeRequired: false,
      })
      .where(eq(users.id, user.id))
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.password.initial',
      ip: request.ip,
      success: true,
    })
    mfaCookie.clear(reply)
    await openSession(request, reply, user)
    return { ok: true }
  })

  /** Changement de mot de passe par l'utilisateur connecté : ses autres sessions sont fermées. */
  app.post('/password', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Authentification requise' })
    if (request.user.provider !== 'local') {
      return reply
        .code(400)
        .send({ error: 'Le mot de passe d’un compte SSO se change chez le fournisseur' })
    }
    const parsed = changePasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue?.message, field: issue?.path.join('.') })
    }
    const [user] = await db.select().from(users).where(eq(users.id, request.user.id)).limit(1)
    if (
      !user?.passwordHash ||
      !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))
    ) {
      await audit(db, {
        userId: request.user.id,
        username: request.user.username,
        action: 'auth.password.change',
        ip: request.ip,
        success: false,
      })
      return reply
        .code(400)
        .send({ error: 'Mot de passe actuel incorrect', field: 'currentPassword' })
    }
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(parsed.data.newPassword),
        passwordChangeRequired: false,
      })
      .where(eq(users.id, user.id))
    const current = request.cookies[sessionCookie]
    await db
      .delete(sessionsTable)
      .where(
        and(
          eq(sessionsTable.userId, user.id),
          ne(sessionsTable.tokenHash, current ? hashToken(current) : ''),
        ),
      )
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.password.change',
      ip: request.ip,
      success: true,
    })
    return reply.code(204).send()
  })

  // --- SSO OpenID Connect ------------------------------------------------------------------

  function loginError(reply: FastifyReply, code: SsoError) {
    return reply.redirect(`/connexion?erreur=${code}`)
  }

  app.get('/oidc/login', async (request, reply) => {
    if (!oidc) return reply.code(404).send({ error: 'SSO non configuré' })
    try {
      const { url, pending } = await oidc.startLogin()
      oidcCookie.set(reply, pending)
      return reply.redirect(url)
    } catch (error) {
      request.log.error({ err: error }, 'Fournisseur OIDC injoignable')
      return loginError(reply, 'unavailable')
    }
  })

  app.get('/oidc/callback', async (request, reply) => {
    if (!oidc) return reply.code(404).send({ error: 'SSO non configuré' })
    const pending = oidcCookie.get(request)
    oidcCookie.clear(reply)
    if (!pending) return loginError(reply, 'failed')

    let identity
    try {
      // URL de rappel reconstruite depuis PUBLIC_URL : on ne fait pas confiance à l'en-tête Host.
      identity = await oidc.finishLogin(new URL(request.url, publicUrl.origin), pending)
    } catch (error) {
      request.log.warn({ err: error }, 'Échec du retour OIDC')
      await audit(db, { action: 'auth.login.sso', ip: request.ip, success: false })
      return loginError(reply, 'failed')
    }

    if (identity.roles.length === 0) {
      await audit(db, {
        username: identity.username,
        action: 'auth.login.sso',
        ip: request.ip,
        success: false,
        details: { reason: 'no_role' },
      })
      return loginError(reply, 'no_role')
    }

    // Les rôles viennent du fournisseur à chaque connexion : Keycloak reste la référence.
    const [user] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: identity.subject,
        username: identity.username,
        displayName: identity.displayName,
        email: identity.email,
        roles: identity.roles,
      })
      .onConflictDoUpdate({
        target: [users.provider, users.subject],
        set: {
          username: identity.username,
          displayName: identity.displayName,
          email: identity.email,
          roles: identity.roles,
        },
      })
      .returning()
    if (!user || user.disabled) return loginError(reply, 'disabled')

    await openSession(request, reply, user, { sid: identity.sid, idToken: identity.idToken })
    return reply.redirect('/')
  })

  // Déconnexion back-channel : Keycloak appelle Vercio quand une session SSO est fermée.
  await app.register(async (backchannel) => {
    backchannel.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    )
    backchannel.post('/oidc/backchannel-logout', async (request, reply) => {
      if (!oidc) return reply.code(404).send({ error: 'SSO non configuré' })
      const token = (request.body as Record<string, string> | undefined)?.logout_token
      if (!token) return reply.code(400).send({ error: 'logout_token manquant' })
      try {
        const { sid, sub } = await oidc.verifyLogoutToken(token)
        let userId: string | undefined
        if (!sid && sub) {
          const [user] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.provider, 'oidc'), eq(users.subject, sub)))
            .limit(1)
          userId = user?.id
        }
        const closed = await sessions.destroyByOidc({ sid: sid ?? undefined, userId })
        request.log.info({ closed }, 'Déconnexion back-channel')
        reply.header('Cache-Control', 'no-store')
        return { ok: true }
      } catch (error) {
        request.log.warn({ err: error }, 'logout_token refusé')
        return reply.code(400).send({ error: 'logout_token invalide' })
      }
    })
  })

  app.post('/logout', async (request, reply): Promise<LogoutResult> => {
    const token = request.cookies[sessionCookie]
    let redirectTo: string | null = null
    if (token) {
      const session = await sessions.find(token)
      await sessions.destroy(token)
      if (session?.idTokenEnc && oidc) {
        try {
          redirectTo = await oidc.endSessionUrl(box.decrypt(session.idTokenEnc))
        } catch (error) {
          request.log.warn({ err: error }, 'URL de déconnexion SSO indisponible')
        }
      }
    }
    reply.clearCookie(sessionCookie, { path: '/' })
    return { redirectTo }
  })
}
