import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import QRCode from 'qrcode'
import {
  changePasswordSchema,
  firstRunSchema,
  initialPasswordSchema,
  localLoginSchema,
  MAX_TOTP_DEVICES,
  recoveryCodeSchema,
  recoveryCodesRegenerateSchema,
  totpCodeSchema,
  totpDeviceAddSchema,
  totpDeviceRemoveSchema,
  type AuthConfig,
  type LocalLoginResult,
  type LogoutResult,
  type RecoveryCodesIssued,
  type RecoveryCodesStatus,
  type SsoError,
  type TotpDeviceView,
  type TotpSetup,
  type TotpVerifyResult,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import { sessions as sessionsTable, totpDevices, totpRecoveryCodes, users } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { hashToken, randomToken, type SecretBox } from '../lib/crypto.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { generateRecoveryCodes, hashRecoveryCode } from '../lib/recovery-codes.js'
import { generateTotpSecret, totpClockOffset, totpUri, verifyTotp } from '../lib/totp.js'
import type { PendingLogin } from './oidc.js'
import type { SsoManager } from './sso.js'
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
  /** SSO en service (.env ou interface), relu à chaque requête : changeable à chaud. */
  sso: SsoManager
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

/** Nom donné à la première application, enrôlée à la connexion. */
const FIRST_DEVICE_NAME = 'Application d’authentification'

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
  return totpLockRemaining(userId) > 0
}

/** Temps restant avant de pouvoir réessayer (ms), 0 si le compte n'est pas bloqué. */
export function totpLockRemaining(userId: string): number {
  const entry = totpFailures.get(userId)
  if (!entry) return 0
  const elapsed = Date.now() - entry.since
  if (elapsed > TOTP_LOCK_MS) {
    totpFailures.delete(userId)
    return 0
  }
  return entry.count >= TOTP_MAX_FAILURES ? TOTP_LOCK_MS - elapsed : 0
}

/** Message du blocage, avec l'heure à laquelle réessayer. */
export function totpLockMessage(userId: string): string {
  const minutes = Math.max(1, Math.ceil(totpLockRemaining(userId) / 60_000))
  return `Trop de codes refusés : réessayez dans ${minutes} min (ou redémarrez Vercio pour lever le blocage tout de suite)`
}

/**
 * Explique un code refusé : un code d'une heure éloignée (horloge décalée) est signalé comme
 * tel au lieu d'un « code invalide » qui laisse penser à une erreur de saisie.
 */
function invalidCodeMessage(offsetSeconds: number | null): string {
  if (offsetSeconds === null) return 'Code invalide'
  const minutes = Math.round(Math.abs(offsetSeconds) / 60)
  const amount = minutes >= 1 ? `${minutes} min` : `${Math.abs(offsetSeconds)} s`
  return `Code refusé : l’heure du serveur et celle de votre application diffèrent d’environ ${amount}. Synchronisez l’horloge du serveur (NTP) ou celle de votre téléphone.`
}

/** Résultat de la vérification d'un code : accepté, déjà utilisé, ou refusé (avec décalage). */
type CodeCheck =
  | { status: 'ok'; step: number }
  | { status: 'reused' }
  | { status: 'invalid'; offsetSeconds: number | null }

const REUSED_MESSAGE =
  'Ce code vient déjà d’être utilisé : attendez que votre application en affiche un nouveau'

export function totpFailed(userId: string): void {
  const entry = totpFailures.get(userId)
  if (!entry || Date.now() - entry.since > TOTP_LOCK_MS) {
    totpFailures.set(userId, { count: 1, since: Date.now() })
  } else {
    entry.count++
  }
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const { db, sessions, box, publicUrl, localEnabled, setupCode, sso } = opts
  const secure = publicUrl.protocol === 'https:'
  const sessionCookie = sessionCookieName(secure)
  // `__Secure-` en HTTPS : le navigateur refuse qu'un domaine voisin pose ces cookies.
  const prefix = secure ? '__Secure-' : ''
  const mfaCookie = new SealedCookie<MfaTicket>(`${prefix}vercio_mfa`, box, 5 * 60, secure)
  // Ajout d'une application par un utilisateur connecté : secret en attente du premier code.
  const deviceCookie = new SealedCookie<{ userId: string; secret: string }>(
    `${prefix}vercio_totp_device`,
    box,
    10 * 60,
    secure,
  )
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
    oidcEnabled: sso.current() !== null,
    oidcProviderName: sso.current()?.providerName ?? null,
  }))

  async function deviceCount(userId: string, executor: Pick<Database, 'select'> = db) {
    const [row] = await executor
      .select({ value: sql<number>`count(*)::int` })
      .from(totpDevices)
      .where(eq(totpDevices.userId, userId))
    return row?.value ?? 0
  }

  /**
   * Code d'une des applications du compte. Mise à jour conditionnelle du dernier pas : deux
   * requêtes simultanées avec le même code (relais de phishing) n'en valident qu'une.
   */
  async function checkDeviceCode(userId: string, code: string): Promise<CodeCheck> {
    const devices = await db.select().from(totpDevices).where(eq(totpDevices.userId, userId))
    let offsetSeconds: number | null = null
    for (const device of devices) {
      const secret = box.decrypt(device.secretEnc)
      const step = verifyTotp(secret, code)
      if (step === null) {
        offsetSeconds ??= totpClockOffset(secret, code)
        continue
      }
      if (device.lastStep !== null && step <= device.lastStep) return { status: 'reused' }
      const [accepted] = await db
        .update(totpDevices)
        .set({ lastStep: step, lastUsedAt: new Date() })
        .where(
          and(
            eq(totpDevices.id, device.id),
            or(isNull(totpDevices.lastStep), lt(totpDevices.lastStep, step)),
          ),
        )
        .returning({ id: totpDevices.id })
      return accepted ? { status: 'ok', step } : { status: 'reused' }
    }
    return { status: 'invalid', offsetSeconds }
  }

  /** Première application, à la connexion : une seule, même si deux codes arrivent ensemble. */
  async function enrollFirstDevice(userId: string, secretEnc: string, step: number) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${userId} for update`)
      if ((await deviceCount(userId, tx)) > 0) return false
      await tx.insert(totpDevices).values({
        userId,
        name: FIRST_DEVICE_NAME,
        secretEnc,
        lastStep: step,
        lastUsedAt: new Date(),
      })
      return true
    })
  }

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

    const stage = (await deviceCount(user.id)) > 0 ? 'verify' : 'setup'
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

    // Même clé si l'écran est redemandé (double appel, retour sur la page) : le QR code déjà
    // scanné reste valable, et la clé affichée correspond toujours à celle attendue.
    const secret = ticket.pendingSecret ?? generateTotpSecret()
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
      return reply.code(429).send({ error: totpLockMessage(user.id) })
    }

    let check: CodeCheck
    if (ticket.stage === 'setup') {
      if (!ticket.pendingSecret) {
        return reply.code(400).send({ error: 'Enrôlement TOTP non démarré' })
      }
      const step = verifyTotp(ticket.pendingSecret, parsed.data.code)
      if (step === null) {
        check = {
          status: 'invalid',
          offsetSeconds: totpClockOffset(ticket.pendingSecret, parsed.data.code),
        }
      } else {
        const enrolled = await enrollFirstDevice(user.id, box.encrypt(ticket.pendingSecret), step)
        check = enrolled ? { status: 'ok', step } : { status: 'reused' }
      }
    } else {
      check = await checkDeviceCode(user.id, parsed.data.code)
    }
    if (check.status === 'invalid') {
      totpFailed(user.id)
      if (check.offsetSeconds !== null) {
        request.log.warn(
          { offsetSeconds: check.offsetSeconds },
          'Code TOTP valide pour une autre heure : horloge du serveur ou du téléphone décalée',
        )
      }
      await audit(db, {
        userId: user.id,
        username: user.username,
        action: 'auth.totp',
        ip: request.ip,
        success: false,
      })
      if (totpLocked(user.id)) return reply.code(429).send({ error: totpLockMessage(user.id) })
      return reply.code(401).send({ error: invalidCodeMessage(check.offsetSeconds) })
    }
    if (check.status === 'reused') return reply.code(401).send({ error: REUSED_MESSAGE })
    totpFailures.delete(user.id)
    let recoveryCodes: string[] | undefined
    if (ticket.stage === 'setup') {
      // Codes de secours avec la première application : affichés une seule fois.
      recoveryCodes = await issueRecoveryCodes(user.id)
      await audit(db, {
        userId: user.id,
        username: user.username,
        action: 'auth.totp.enroll',
        ip: request.ip,
        success: true,
      })
    }
    return finishSecondFactor(request, reply, user, { recoveryCodes })
  })

  /** Double authentification réussie : session ouverte, ou mot de passe temporaire à remplacer. */
  async function finishSecondFactor(
    request: FastifyRequest,
    reply: FastifyReply,
    user: typeof users.$inferSelect,
    extra: Omit<TotpVerifyResult, 'next'>,
  ): Promise<TotpVerifyResult> {
    // Mot de passe temporaire : la session n'est ouverte qu'une fois remplacé.
    if (user.passwordChangeRequired) {
      mfaCookie.set(reply, { userId: user.id, stage: 'password' })
      return { next: 'password_change', ...extra }
    }
    mfaCookie.clear(reply)
    await openSession(request, reply, user)
    return { next: 'done', ...extra }
  }

  /** Nouveaux codes de secours : les anciens ne fonctionnent plus. Renvoie les codes en clair. */
  async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes()
    await db.transaction(async (tx) => {
      await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId))
      await tx
        .insert(totpRecoveryCodes)
        .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })))
    })
    return codes
  }

  async function recoveryStatus(userId: string): Promise<RecoveryCodesStatus> {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        remaining: sql<number>`count(*) filter (where ${totpRecoveryCodes.usedAt} is null)::int`,
        createdAt: sql<Date | null>`min(${totpRecoveryCodes.createdAt})`,
      })
      .from(totpRecoveryCodes)
      .where(eq(totpRecoveryCodes.userId, userId))
    const createdAt = row?.createdAt ? new Date(row.createdAt).toISOString() : null
    return { total: row?.total ?? 0, remaining: row?.remaining ?? 0, createdAt }
  }

  /**
   * Connexion avec un code de secours, à la place du code TOTP. Usage unique (mise à jour
   * conditionnelle) ; les échecs comptent dans la même limite que les codes TOTP.
   */
  app.post('/totp/recovery/verify', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const ticket = mfaCookie.get(request)
    if (!ticket || ticket.stage === 'password') {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    const parsed = recoveryCodeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Code de secours attendu' })
    const [user] = await db.select().from(users).where(eq(users.id, ticket.userId)).limit(1)
    if (!user || user.disabled) {
      return reply.code(401).send({ error: 'Session de connexion expirée' })
    }
    if (totpLocked(user.id)) return reply.code(429).send({ error: totpLockMessage(user.id) })

    const [used] = await db
      .update(totpRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(totpRecoveryCodes.userId, user.id),
          eq(totpRecoveryCodes.codeHash, hashRecoveryCode(parsed.data.code)),
          isNull(totpRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: totpRecoveryCodes.id })
    if (!used) {
      totpFailed(user.id)
      await audit(db, {
        userId: user.id,
        username: user.username,
        action: 'auth.recovery',
        ip: request.ip,
        success: false,
      })
      if (totpLocked(user.id)) return reply.code(429).send({ error: totpLockMessage(user.id) })
      return reply.code(401).send({ error: 'Code de secours invalide ou déjà utilisé' })
    }
    totpFailures.delete(user.id)
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.recovery',
      ip: request.ip,
      success: true,
    })
    // Pas d'application enregistrée (réinitialisée) : elle sera reconfigurée à la prochaine
    // connexion ; le code de secours suffit pour celle-ci.
    const { remaining } = await recoveryStatus(user.id)
    return finishSecondFactor(request, reply, user, { recoveryRemaining: remaining })
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

  // --- Applications d'authentification de l'utilisateur connecté --------------------------

  /** Compte local connecté et mot de passe actuel vérifié ; sinon la réponse d'erreur est envoyée. */
  async function confirmLocalUser(
    request: FastifyRequest,
    reply: FastifyReply,
    currentPassword: string,
    action: string,
  ) {
    const [user] = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1)
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      await audit(db, {
        userId: request.user!.id,
        username: request.user!.username,
        action,
        ip: request.ip,
        success: false,
      })
      reply.code(400).send({ error: 'Mot de passe actuel incorrect', field: 'currentPassword' })
      return null
    }
    return user
  }

  /** Utilisateur connecté avec un compte local ; sinon la réponse d'erreur est envoyée. */
  function requireLocalUser(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!request.user) {
      reply.code(401).send({ error: 'Authentification requise' })
      return false
    }
    if (request.user.provider !== 'local') {
      reply
        .code(400)
        .send({ error: 'La double authentification d’un compte SSO se gère chez le fournisseur' })
      return false
    }
    return true
  }

  app.get('/totp/recovery', async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    return recoveryStatus(request.user!.id)
  })

  app.post('/totp/recovery', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    const parsed = recoveryCodesRegenerateSchema.safeParse(request.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue?.message, field: issue?.path.join('.') })
    }
    const user = await confirmLocalUser(
      request,
      reply,
      parsed.data.currentPassword,
      'auth.recovery.regenerate',
    )
    if (!user) return
    const codes = await issueRecoveryCodes(user.id)
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.recovery.regenerate',
      ip: request.ip,
      success: true,
    })
    const result: RecoveryCodesIssued = { codes }
    return result
  })

  app.get('/totp/devices', async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    const rows = await db
      .select()
      .from(totpDevices)
      .where(eq(totpDevices.userId, request.user!.id))
      .orderBy(asc(totpDevices.createdAt))
    return rows.map((row): TotpDeviceView => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }))
  })

  /** Nouveau secret, gardé dans un cookie scellé jusqu'à la confirmation par un premier code. */
  app.post('/totp/devices/setup', async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    if ((await deviceCount(request.user!.id)) >= MAX_TOTP_DEVICES) {
      return reply
        .code(400)
        .send({ error: `${MAX_TOTP_DEVICES} applications au plus : supprimez-en une d’abord` })
    }
    const secret = generateTotpSecret()
    deviceCookie.set(reply, { userId: request.user!.id, secret })
    const uri = totpUri(secret, request.user!.username)
    const result: TotpSetup = {
      secret,
      uri,
      qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1 }),
    }
    return result
  })

  app.post('/totp/devices', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    const parsed = totpDeviceAddSchema.safeParse(request.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue?.message, field: issue?.path.join('.') })
    }
    const pending = deviceCookie.get(request)
    if (!pending || pending.userId !== request.user!.id) {
      return reply.code(400).send({ error: 'QR code expiré : recommencez l’ajout' })
    }
    const user = await confirmLocalUser(
      request,
      reply,
      parsed.data.currentPassword,
      'auth.totp.add',
    )
    if (!user) return
    if (totpLocked(user.id)) {
      return reply.code(429).send({ error: totpLockMessage(user.id) })
    }
    const step = verifyTotp(pending.secret, parsed.data.code)
    if (step === null) {
      totpFailed(user.id)
      const message = invalidCodeMessage(totpClockOffset(pending.secret, parsed.data.code))
      return reply.code(400).send({ error: message, field: 'code' })
    }
    const added = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${user.id} for update`)
      if ((await deviceCount(user.id, tx)) >= MAX_TOTP_DEVICES) return null
      const [row] = await tx
        .insert(totpDevices)
        .values({
          userId: user.id,
          name: parsed.data.name,
          secretEnc: box.encrypt(pending.secret),
          lastStep: step,
          lastUsedAt: new Date(),
        })
        .returning()
      return row ?? null
    })
    if (!added) {
      return reply.code(400).send({ error: `${MAX_TOTP_DEVICES} applications au plus` })
    }
    deviceCookie.clear(reply)
    totpFailures.delete(user.id)
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.totp.add',
      target: added.name,
      ip: request.ip,
      success: true,
    })
    const result: TotpDeviceView = {
      id: added.id,
      name: added.name,
      createdAt: added.createdAt.toISOString(),
      lastUsedAt: added.lastUsedAt?.toISOString() ?? null,
    }
    return reply.code(201).send(result)
  })

  /** Suppression d'une application : il en reste toujours une. */
  app.delete('/totp/devices/:id', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    if (!requireLocalUser(request, reply)) return
    const { id } = request.params as { id: string }
    const parsed = totpDeviceRemoveSchema.safeParse(request.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue?.message, field: issue?.path.join('.') })
    }
    const user = await confirmLocalUser(
      request,
      reply,
      parsed.data.currentPassword,
      'auth.totp.remove',
    )
    if (!user) return
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from users where id = ${user.id} for update`)
      const devices = await tx
        .select({ id: totpDevices.id, name: totpDevices.name })
        .from(totpDevices)
        .where(eq(totpDevices.userId, user.id))
      const device = devices.find((item) => item.id === id)
      if (!device) return 'missing' as const
      if (devices.length <= 1) return 'last' as const
      await tx.delete(totpDevices).where(eq(totpDevices.id, device.id))
      return device
    })
    if (outcome === 'missing') return reply.code(404).send({ error: 'Application introuvable' })
    if (outcome === 'last') {
      return reply.code(400).send({
        error: 'Gardez au moins une application : ajoutez-en une autre avant de supprimer celle-ci',
      })
    }
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: 'auth.totp.remove',
      target: outcome.name,
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
    const oidc = sso.current()?.service
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
    const oidc = sso.current()?.service
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
      const oidc = sso.current()?.service
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
      const oidc = sso.current()?.service
      if (session?.idTokenEnc && oidc) {
        try {
          redirectTo = await oidc.endSessionUrl(box.decrypt(session.idTokenEnc))
        } catch (error) {
          request.log.warn({ err: error }, 'URL de déconnexion SSO indisponible')
        }
      }
    }
    reply.clearCookie(sessionCookie, { path: '/', httpOnly: true, secure, sameSite: 'lax' })
    return { redirectTo }
  })
}
