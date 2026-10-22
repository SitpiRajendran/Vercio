import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  roleSchema,
  userCreateSchema,
  userUpdateSchema,
  type UserView,
  type UserWithPassword,
} from '@vercio/shared'
import type { Database } from '../db/client.js'
import { sessions, totpDevices, users } from '../db/schema.js'
import { hashPassword, temporaryPassword } from '../lib/password.js'
import { auditAction, isUniqueViolation, parseInput } from './helpers.js'

type UserRow = typeof users.$inferSelect

/** `devices` : applications d'authentification enregistrées sur le compte. */
export function toUserView(row: UserRow, devices: number): UserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    provider: row.provider,
    roles: row.roles.flatMap((role) => {
      const parsed = roleSchema.safeParse(role)
      return parsed.success ? [parsed.data] : []
    }),
    disabled: row.disabled,
    totpEnabled: devices > 0,
    totpDevices: devices,
    passwordChangeRequired: row.passwordChangeRequired,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Comptes utilisateurs (rôle vercio-admin) : comptes locaux créés dans Vercio, et comptes SSO
 * apparus à leur première connexion (lecture seule, sauf la désactivation).
 */
export const userRoutes: FastifyPluginAsync<{ db: Database; localEnabled: boolean }> = async (
  app,
  { db, localEnabled },
) => {
  app.addHook('preHandler', app.requireRole('vercio-admin'))
  const idParams = z.object({ id: z.uuid() })

  async function find(id: string) {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
    return row ?? null
  }

  /**
   * Il doit toujours rester un administrateur local actif : c'est l'accès de secours quand le
   * SSO est indisponible, et le seul accès quand il n'est pas configuré.
   */
  async function otherActiveLocalAdmins(exceptId: string): Promise<number> {
    const [row] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.provider, 'local'),
          eq(users.disabled, false),
          ne(users.id, exceptId),
          sql`'vercio-admin' = any(${users.roles})`,
        ),
      )
    return row?.value ?? 0
  }

  const isActiveLocalAdmin = (row: UserRow) =>
    row.provider === 'local' && !row.disabled && row.roles.includes('vercio-admin')

  /** Nombre d'applications d'authentification par compte. */
  async function deviceCounts(): Promise<Map<string, number>> {
    const rows = await db
      .select({ userId: totpDevices.userId, value: sql<number>`count(*)::int` })
      .from(totpDevices)
      .groupBy(totpDevices.userId)
    return new Map(rows.map((row) => [row.userId, row.value]))
  }

  const view = async (row: UserRow) => toUserView(row, (await deviceCounts()).get(row.id) ?? 0)

  const closeSessions = (userId: string) => db.delete(sessions).where(eq(sessions.userId, userId))

  const track = (request: FastifyRequest, action: string, row: UserRow, details?: object) =>
    auditAction(db, request, action, row.username, details as Record<string, unknown>)

  app.get('/', async (): Promise<UserView[]> => {
    const rows = await db.select().from(users).orderBy(asc(users.provider), asc(users.username))
    const counts = await deviceCounts()
    return rows.map((row) => toUserView(row, counts.get(row.id) ?? 0))
  })

  app.post('/', async (request, reply) => {
    if (!localEnabled) {
      return reply.code(400).send({ error: 'Comptes locaux désactivés (VERCIO_LOCAL_AUTH=false)' })
    }
    const input = parseInput(userCreateSchema, request.body, reply)
    if (!input) return
    const password = temporaryPassword()
    try {
      const [row] = await db
        .insert(users)
        .values({
          provider: 'local',
          subject: input.username,
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          roles: [input.role],
          passwordHash: await hashPassword(password),
          passwordChangeRequired: true,
        })
        .returning()
      await track(request, 'user.create', row!, { role: input.role })
      const result: UserWithPassword = { user: toUserView(row!, 0), temporaryPassword: password }
      return reply.code(201).send(result)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Cet identifiant existe déjà', field: 'username' })
      }
      throw error
    }
  })

  app.put('/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    const input = params && parseInput(userUpdateSchema, request.body, reply)
    if (!params || !input) return
    const row = await find(params.id)
    if (!row) return reply.code(404).send({ error: 'Utilisateur introuvable' })

    if (row.id === request.user!.id && (input.disabled || input.role !== 'vercio-admin')) {
      return reply.code(400).send({
        error: 'Vous ne pouvez ni désactiver votre propre compte, ni retirer votre rôle admin',
      })
    }
    const losesAdmin = input.disabled || input.role !== 'vercio-admin'
    if (isActiveLocalAdmin(row) && losesAdmin && (await otherActiveLocalAdmins(row.id)) === 0) {
      return reply.code(400).send({
        error: 'Il doit rester au moins un administrateur local actif (compte de secours)',
      })
    }

    // Compte SSO : nom, email et rôles viennent du fournisseur à chaque connexion.
    const values =
      row.provider === 'local'
        ? {
            displayName: input.displayName,
            email: input.email,
            roles: [input.role],
            disabled: input.disabled,
          }
        : { disabled: input.disabled }
    const [updated] = await db.update(users).set(values).where(eq(users.id, row.id)).returning()
    if (input.disabled && !row.disabled) await closeSessions(row.id)
    await track(request, 'user.update', row, values)
    return view(updated!)
  })

  /** Nouveau mot de passe temporaire, à changer à la prochaine connexion. */
  app.post('/:id/reset-password', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const row = await find(params.id)
    if (!row) return reply.code(404).send({ error: 'Utilisateur introuvable' })
    if (row.provider !== 'local') {
      return reply
        .code(400)
        .send({ error: 'Le mot de passe d’un compte SSO se gère chez le fournisseur' })
    }
    const password = temporaryPassword()
    const [updated] = await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), passwordChangeRequired: true })
      .where(eq(users.id, row.id))
      .returning()
    await closeSessions(row.id)
    await track(request, 'user.reset_password', row)
    const result: UserWithPassword = { user: await view(updated!), temporaryPassword: password }
    return result
  })

  /** La double authentification sera de nouveau configurée à la prochaine connexion. */
  app.post('/:id/reset-totp', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const row = await find(params.id)
    if (!row) return reply.code(404).send({ error: 'Utilisateur introuvable' })
    if (row.provider !== 'local') {
      return reply
        .code(400)
        .send({ error: 'La double authentification d’un compte SSO se gère chez le fournisseur' })
    }
    await db.delete(totpDevices).where(eq(totpDevices.userId, row.id))
    await closeSessions(row.id)
    await track(request, 'user.reset_totp', row)
    return toUserView(row, 0)
  })

  app.delete('/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply)
    if (!params) return
    const row = await find(params.id)
    if (!row) return reply.code(404).send({ error: 'Utilisateur introuvable' })
    if (row.id === request.user!.id) {
      return reply.code(400).send({ error: 'Vous ne pouvez pas supprimer votre propre compte' })
    }
    if (isActiveLocalAdmin(row) && (await otherActiveLocalAdmins(row.id)) === 0) {
      return reply.code(400).send({
        error: 'Il doit rester au moins un administrateur local actif (compte de secours)',
      })
    }
    // Les déploiements et l'audit gardent la trace (user_id mis à NULL, nom conservé dans l'audit).
    await db.delete(users).where(eq(users.id, row.id))
    await track(request, 'user.delete', row)
    return reply.code(204).send()
  })
}
