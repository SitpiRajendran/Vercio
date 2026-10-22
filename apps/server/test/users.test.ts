import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql as rawSql } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { UserView, UserWithPassword } from '@vercio/shared'
import { SessionStore } from '../src/auth/sessions.js'
import type { Database } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import {
  controlledClock,
  cookieValue,
  ORIGIN,
  setupTestApp,
  TEST_DATABASE_URL,
  totpCode,
} from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('API — comptes utilisateurs', () => {
  let app: FastifyInstance
  let db: Database
  let close: () => Promise<void>
  /** Administrateur SSO qui gère les comptes (le seul admin local est celui de l'installation). */
  let admin: string
  let adminId: string
  const clock = controlledClock()
  /** Secrets TOTP enregistrés par compte, pour les connexions suivantes. */
  const secrets = new Map<string, string>()

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    cookie: string = admin,
  ) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(payload ? { payload } : {}),
    })

  const listUsers = async () => (await call('GET', '/settings/users')).json<UserView[]>()
  const byName = async (username: string) =>
    (await listUsers()).find((u) => u.username === username)!

  async function createUser(username: string, role = 'vercio-deployer') {
    const response = await call('POST', '/settings/users', {
      username,
      displayName: username.toUpperCase(),
      email: `${username}@example.com`,
      role,
    })
    expect(response.statusCode).toBe(201)
    return response.json<UserWithPassword>()
  }

  /**
   * Connexion locale complète : mot de passe, TOTP (enrôlé au besoin), puis remplacement du
   * mot de passe temporaire si demandé. Renvoie le cookie de session.
   */
  async function login(username: string, password: string, newPassword?: string) {
    clock.tick()
    const first = await call('POST', '/auth/login', { username, password }, '')
    expect(first.statusCode).toBe(200)
    let mfa = cookieValue(first, '__Secure-vercio_mfa')
    if (first.json().next === 'totp_setup') {
      const setup = await call('POST', '/auth/totp/setup', {}, mfa)
      secrets.set(username, setup.json().secret)
      mfa = cookieValue(setup, '__Secure-vercio_mfa')
    }
    const verify: LightMyRequestResponse = await call(
      'POST',
      '/auth/totp/verify',
      { code: totpCode(secrets.get(username)!, clock.step()) },
      mfa,
    )
    if (verify.json().next === 'done') return cookieValue(verify, '__Host-vercio_session')
    expect(verify.json()).toEqual({ next: 'password_change' })
    expect(newPassword).toBeDefined()
    const changed = await call(
      'POST',
      '/auth/password/initial',
      { password: newPassword },
      cookieValue(verify, '__Secure-vercio_mfa'),
    )
    expect(changed.statusCode).toBe(200)
    return cookieValue(changed, '__Host-vercio_session')
  }

  beforeAll(async () => {
    ;({ app, db, close } = await setupTestApp())
    const [user] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'sso-alice',
        username: 'alice',
        displayName: 'Alice',
        roles: ['vercio-admin'],
      })
      .returning()
    adminId = user!.id
    admin = `__Host-vercio_session=${(await new SessionStore(db, 3_600_000).create(adminId, {})).token}`
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await close?.()
  })

  it('liste les comptes locaux et SSO', async () => {
    const list = await listUsers()
    expect(list.map((u) => `${u.provider}:${u.username}`)).toEqual(['local:admin', 'oidc:alice'])
    expect(list[0]).toMatchObject({
      roles: ['vercio-admin'],
      totpEnabled: false,
      passwordChangeRequired: true,
    })
  })

  it('crée un compte local avec un mot de passe temporaire', async () => {
    const created = await createUser('bob')
    expect(created.temporaryPassword).toMatch(/^[a-zA-Z2-9]{20}$/)
    expect(created.user).toMatchObject({
      username: 'bob',
      displayName: 'BOB',
      email: 'bob@example.com',
      provider: 'local',
      roles: ['vercio-deployer'],
      passwordChangeRequired: true,
      totpEnabled: false,
    })

    const duplicate = await call('POST', '/settings/users', {
      username: 'Bob',
      displayName: 'Bob',
      role: 'vercio-viewer',
    })
    expect(duplicate.json()).toMatchObject({ field: 'username' })
    expect(duplicate.statusCode).toBe(409)
    const invalid = await call('POST', '/settings/users', {
      username: 'b o b',
      displayName: 'Bob',
      role: 'vercio-viewer',
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('première connexion : TOTP puis nouveau mot de passe, avec le rôle attribué', async () => {
    const { temporaryPassword } = await createUser('carole', 'vercio-viewer')
    const cookie = await login('carole', temporaryPassword, 'carole-mot-de-passe-1')
    const me = await call('GET', '/auth/me', undefined, cookie)
    expect(me.json()).toMatchObject({ username: 'carole', roles: ['vercio-viewer'] })
    expect(await byName('carole')).toMatchObject({
      totpEnabled: true,
      totpDevices: 1,
      passwordChangeRequired: false,
    })
    // Un lecteur n'administre pas les comptes.
    expect((await call('GET', '/settings/users', undefined, cookie)).statusCode).toBe(403)
  })

  it('change son mot de passe : les autres sessions sont fermées', async () => {
    const { temporaryPassword } = await createUser('david')
    const first = await login('david', temporaryPassword, 'david-mot-de-passe-1')
    const second = await login('david', 'david-mot-de-passe-1')

    const wrong = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'faux', newPassword: 'david-mot-de-passe-2' },
      second,
    )
    expect(wrong.json()).toMatchObject({ field: 'currentPassword' })
    const ok = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'david-mot-de-passe-1', newPassword: 'david-mot-de-passe-2' },
      second,
    )
    expect(ok.statusCode).toBe(204)
    expect((await call('GET', '/auth/me', undefined, second)).statusCode).toBe(200)
    expect((await call('GET', '/auth/me', undefined, first)).statusCode).toBe(401)
    await login('david', 'david-mot-de-passe-2')

    // Un compte SSO n'a pas de mot de passe dans Vercio.
    const sso = await call('POST', '/auth/password', {
      currentPassword: 'x',
      newPassword: 'nouveau-mot-de-passe',
    })
    expect(sso.statusCode).toBe(400)
  })

  it('réinitialise le mot de passe et la double authentification', async () => {
    const { user, temporaryPassword } = await createUser('emma')
    const session = await login('emma', temporaryPassword, 'emma-mot-de-passe-1')

    const reset = await call('POST', `/settings/users/${user.id}/reset-password`)
    const { temporaryPassword: second } = reset.json<UserWithPassword>()
    expect(reset.json().user.passwordChangeRequired).toBe(true)
    expect((await call('GET', '/auth/me', undefined, session)).statusCode).toBe(401)
    const oldPassword = await call('POST', '/auth/login', {
      username: 'emma',
      password: 'emma-mot-de-passe-1',
    })
    expect(oldPassword.statusCode).toBe(401)
    await login('emma', second, 'emma-mot-de-passe-2')

    const totp = await call('POST', `/settings/users/${user.id}/reset-totp`)
    expect(totp.json()).toMatchObject({ totpEnabled: false })
    clock.tick()
    const next = await call('POST', '/auth/login', {
      username: 'emma',
      password: 'emma-mot-de-passe-2',
    })
    expect(next.json()).toEqual({ next: 'totp_setup' })
  })

  it('modifie et désactive un compte', async () => {
    const { user, temporaryPassword } = await createUser('franck')
    const session = await login('franck', temporaryPassword, 'franck-mot-de-passe')

    const updated = await call('PUT', `/settings/users/${user.id}`, {
      displayName: 'Franck Martin',
      email: '',
      role: 'vercio-admin',
      disabled: false,
    })
    expect(updated.json()).toMatchObject({
      displayName: 'Franck Martin',
      email: null,
      roles: ['vercio-admin'],
    })

    await call('PUT', `/settings/users/${user.id}`, {
      displayName: 'Franck Martin',
      role: 'vercio-viewer',
      disabled: true,
    })
    expect((await call('GET', '/auth/me', undefined, session)).statusCode).toBe(401)
    const refused = await call('POST', '/auth/login', {
      username: 'franck',
      password: 'franck-mot-de-passe',
    })
    expect(refused.statusCode).toBe(401)
  })

  it('compte SSO : seule la désactivation est modifiable', async () => {
    const [sso] = await db
      .insert(users)
      .values({
        provider: 'oidc',
        subject: 'sso-gaby',
        username: 'gaby',
        displayName: 'Gaby',
        roles: ['vercio-viewer'],
      })
      .returning()
    const updated = await call('PUT', `/settings/users/${sso!.id}`, {
      displayName: 'Autre nom',
      role: 'vercio-admin',
      disabled: true,
    })
    expect(updated.json()).toMatchObject({
      displayName: 'Gaby',
      roles: ['vercio-viewer'],
      disabled: true,
    })
    const reset = await call('POST', `/settings/users/${sso!.id}/reset-password`)
    expect(reset.statusCode).toBe(400)
  })

  it('protège contre la perte de l’accès administrateur', async () => {
    // Pas d'auto-désactivation, ni d'auto-rétrogradation.
    const self = await call('PUT', `/settings/users/${adminId}`, {
      displayName: 'Alice',
      role: 'vercio-viewer',
      disabled: false,
    })
    expect(self.statusCode).toBe(400)
    expect((await call('DELETE', `/settings/users/${adminId}`)).statusCode).toBe(400)

    // « franck » a été désactivé : « admin » est le dernier administrateur local actif.
    const localAdmin = await byName('admin')
    const disable = await call('PUT', `/settings/users/${localAdmin.id}`, {
      displayName: 'Administrateur',
      role: 'vercio-admin',
      disabled: true,
    })
    expect(disable.json().error).toContain('au moins un administrateur local')
    expect((await call('DELETE', `/settings/users/${localAdmin.id}`)).statusCode).toBe(400)

    // Avec un second administrateur local actif, c'est possible.
    await createUser('hugo', 'vercio-admin')
    const allowed = await call('PUT', `/settings/users/${localAdmin.id}`, {
      displayName: 'Administrateur',
      role: 'vercio-deployer',
      disabled: false,
    })
    expect(allowed.statusCode).toBe(200)
  })

  it('supprime un compte et journalise les actions', async () => {
    const hugo = await byName('hugo')
    // « hugo » est désormais le seul administrateur local : il est protégé.
    expect((await call('DELETE', `/settings/users/${hugo.id}`)).statusCode).toBe(400)
    const bob = await byName('bob')
    expect((await call('DELETE', `/settings/users/${bob.id}`)).statusCode).toBe(204)
    expect(await byName('bob')).toBeUndefined()

    const rows = await db.execute<{ action: string }>(
      rawSql`select distinct action from audit_logs where action like 'user.%'`,
    )
    expect(rows.map((row) => row.action).sort()).toEqual([
      'user.create',
      'user.delete',
      'user.reset_password',
      'user.reset_totp',
      'user.update',
    ])
  })
})
