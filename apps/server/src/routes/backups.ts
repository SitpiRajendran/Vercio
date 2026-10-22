import { join, relative, resolve } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  backupDestinationInputSchema,
  backupPlanInputSchema,
  backupRestoreInputSchema,
  type BackupDestinationView,
  type BackupItem,
  type BackupPlanPage,
  type BackupPlanView,
  type BackupRestoreView,
  type BackupSchedule,
  type BackupView,
  type ConnectionCheck,
  type VercioBackupPage,
  vercioBackupPlanInputSchema,
  vercioRestoreInputSchema,
  type LocalDestinationConfig,
  type S3DestinationConfig,
} from '@vercio/shared'
import { BackupError, nextRun, type BackupService } from '../backups/service.js'
import { BackupStoreError } from '../backups/store.js'
import type { Database } from '../db/client.js'
import type { HostDriver, SelfContainer } from '../docker/host-driver.js'
import {
  backupDestinations,
  backupPlans,
  backupRestores,
  backups,
  environments,
  projects,
} from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { auditAction, isUniqueViolation, parseInput } from './helpers.js'

const check = (ok: boolean, message: string): ConnectionCheck => ({
  ok,
  message,
  details: [],
  warnings: [],
  checkedAt: new Date().toISOString(),
})

type DestinationRow = typeof backupDestinations.$inferSelect
type BackupRow = typeof backups.$inferSelect
type RestoreRow = typeof backupRestores.$inferSelect

function location(row: Pick<DestinationRow, 'type' | 'config'>): string {
  if (row.type === 'local') return (row.config as LocalDestinationConfig).path
  const config = row.config as S3DestinationConfig
  const path = [config.bucket, config.prefix].filter(Boolean).join('/')
  return `s3://${path}${config.endpoint ? ` (${new URL(config.endpoint).host})` : ''}`
}

/**
 * Chemin sur le serveur d'un dossier vu par Vercio : celui du montage qui le contient (le plus
 * précis) ; null s'il n'est sous aucun montage. Hors conteneur, le chemin est déjà celui du serveur.
 */
export function hostLocation(path: string, self: SelfContainer | null): string | null {
  if (!self) return path
  const target = resolve(path)
  const mount = self.mounts
    .filter((item) => target === item.destination || target.startsWith(`${item.destination}/`))
    .sort((a, b) => b.destination.length - a.destination.length)[0]
  return mount ? join(mount.source, relative(mount.destination, target)) : null
}

function toRestoreView(row: RestoreRow): BackupRestoreView {
  return {
    id: row.id,
    status: row.status as BackupRestoreView['status'],
    items: row.items,
    username: row.username,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** Destinations (réglages) et sauvegardes des environnements. */
export const backupRoutes: FastifyPluginAsync<{
  db: Database
  box: SecretBox
  backups: BackupService
  host: HostDriver
}> = async (app, { db, box, backups: service, host }) => {
  const viewer = { preHandler: app.requireRole('vercio-viewer') }
  const deployer = { preHandler: app.requireRole('vercio-deployer') }
  const admin = { preHandler: app.requireRole('vercio-admin') }

  const fail = (reply: import('fastify').FastifyReply, error: unknown) => {
    if (error instanceof BackupError || error instanceof BackupStoreError) {
      return reply
        .code(error instanceof BackupStoreError ? 502 : 409)
        .send({ error: error.message })
    }
    throw error
  }

  // --- Destinations -------------------------------------------------------------------------

  const destinationParams = z.object({ id: z.uuid() })

  async function destinationViews(): Promise<BackupDestinationView[]> {
    const rows = await db.select().from(backupDestinations).orderBy(backupDestinations.name)
    const counts = await db
      .select({ id: backupPlans.destinationId, count: sql<number>`count(*)::int` })
      .from(backupPlans)
      .groupBy(backupPlans.destinationId)
    const vercio = await service.vercioPlan()
    let self: SelfContainer | null | undefined
    try {
      self = await host.selfContainer()
    } catch {
      self = undefined
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      config: row.config as BackupDestinationView['config'],
      location: location(row),
      encrypted: !!row.passphraseEnc,
      hasCredentials: !!row.credentialsEnc,
      plans:
        (counts.find((count) => count.id === row.id)?.count ?? 0) +
        (vercio?.destinationId === row.id ? 1 : 0),
      ...(row.type === 'local' && self !== undefined
        ? { hostPath: hostLocation((row.config as LocalDestinationConfig).path, self) }
        : {}),
      createdAt: row.createdAt.toISOString(),
    }))
  }

  /** Ligne prête à enregistrer ; `existing` garde les secrets non ressaisis. */
  function destinationValues(
    input: z.infer<typeof backupDestinationInputSchema>,
    existing?: DestinationRow,
  ) {
    let credentialsEnc: string | null = null
    if (input.type === 's3') {
      if (input.credentials) credentialsEnc = box.encrypt(JSON.stringify(input.credentials))
      else if (existing?.type === 's3') {
        // Clés gardées : seulement vers le même service et le même bucket.
        const before = existing.config as S3DestinationConfig
        if (before.endpoint !== input.config.endpoint || before.bucket !== input.config.bucket) {
          throw new BackupError('Ressaisissez les clés d’accès pour changer d’adresse ou de bucket')
        }
        credentialsEnc = existing.credentialsEnc
      }
      if (!credentialsEnc) throw new BackupError('Clés d’accès S3 requises')
    }
    const passphraseEnc =
      input.passphrase === undefined
        ? (existing?.passphraseEnc ?? null)
        : input.passphrase === null
          ? null
          : box.encrypt(input.passphrase)
    return {
      name: input.name,
      type: input.type,
      config: input.config,
      credentialsEnc,
      passphraseEnc,
    }
  }

  app.get('/settings/backup-destinations', admin, async () => destinationViews())

  app.post('/settings/backup-destinations/test', admin, async (request, reply) => {
    const body = request.body as { id?: unknown } | undefined
    const input = parseInput(backupDestinationInputSchema, body, reply)
    if (!input) return
    const id = typeof body?.id === 'string' ? z.uuid().safeParse(body.id).data : undefined
    const [existing] = id
      ? await db.select().from(backupDestinations).where(eq(backupDestinations.id, id))
      : []
    try {
      const values = destinationValues(input, existing)
      const store = service.store({
        ...values,
        id: id ?? '',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      await store.check()
      return check(true, `Écriture et suppression réussies dans ${store.location}`)
    } catch (error) {
      if (error instanceof BackupError || error instanceof BackupStoreError) {
        return check(false, error.message)
      }
      throw error
    }
  })

  app.post('/settings/backup-destinations', admin, async (request, reply) => {
    const input = parseInput(backupDestinationInputSchema, request.body, reply)
    if (!input) return
    try {
      const [row] = await db.insert(backupDestinations).values(destinationValues(input)).returning()
      await auditAction(db, request, 'backup.destination.create', row!.name, { type: row!.type })
      return reply.code(201).send((await destinationViews()).find((item) => item.id === row!.id))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà pris', field: 'name' })
      }
      return fail(reply, error)
    }
  })

  app.put('/settings/backup-destinations/:id', admin, async (request, reply) => {
    const params = parseInput(destinationParams, request.params, reply)
    const input = params && parseInput(backupDestinationInputSchema, request.body, reply)
    if (!params || !input) return
    const [existing] = await db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, params.id))
    if (!existing) return reply.code(404).send({ error: 'Destination introuvable' })
    try {
      await db
        .update(backupDestinations)
        .set(destinationValues(input, existing))
        .where(eq(backupDestinations.id, params.id))
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Ce nom est déjà pris', field: 'name' })
      }
      return fail(reply, error)
    }
    await auditAction(db, request, 'backup.destination.update', input.name, {
      passphrase:
        input.passphrase === undefined ? 'inchangée' : input.passphrase ? 'changée' : 'retirée',
    })
    return (await destinationViews()).find((item) => item.id === params.id)
  })

  app.delete('/settings/backup-destinations/:id', admin, async (request, reply) => {
    const params = parseInput(destinationParams, request.params, reply)
    if (!params) return
    if (await service.destinationInUse(params.id)) {
      return reply.code(409).send({
        error: 'Destination utilisée par des environnements : changez d’abord leur sauvegarde',
      })
    }
    const [row] = await db
      .delete(backupDestinations)
      .where(eq(backupDestinations.id, params.id))
      .returning()
    if (!row) return reply.code(404).send({ error: 'Destination introuvable' })
    await auditAction(db, request, 'backup.destination.delete', row.name)
    return reply.code(204).send()
  })

  // --- Environnements -----------------------------------------------------------------------

  const envParams = z.object({ id: z.uuid(), envId: z.uuid() })
  const backupParams = envParams.extend({ backupId: z.uuid() })
  const base = '/projects/:id/environments/:envId/backups'

  async function findEnvironment(projectId: string, envId: string) {
    const [row] = await db
      .select({ env: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, envId), eq(environments.projectId, projectId)))
      .limit(1)
    return row ?? null
  }

  async function planView(environmentId: string): Promise<BackupPlanView | null> {
    const [row] = await db
      .select({ plan: backupPlans, destination: backupDestinations })
      .from(backupPlans)
      .innerJoin(backupDestinations, eq(backupDestinations.id, backupPlans.destinationId))
      .where(eq(backupPlans.environmentId, environmentId))
    if (!row) return null
    return {
      enabled: row.plan.enabled,
      destination: {
        id: row.destination.id,
        name: row.destination.name,
        encrypted: !!row.destination.passphraseEnc,
      },
      schedule: row.plan.schedule as BackupSchedule,
      keep: row.plan.keep,
      selection: row.plan.selection,
      nextRunAt: row.plan.enabled ? (row.plan.nextRunAt?.toISOString() ?? null) : null,
    }
  }

  async function backupViews(rows: BackupRow[]): Promise<BackupView[]> {
    const ids = rows.map((row) => row.id)
    const destinations = await db
      .select({ id: backupDestinations.id, name: backupDestinations.name })
      .from(backupDestinations)
    const restores = ids.length
      ? await db
          .select()
          .from(backupRestores)
          .where(inArray(backupRestores.backupId, ids))
          .orderBy(desc(backupRestores.startedAt))
      : []
    return rows.map((row) => {
      const restore = restores.find((item) => item.backupId === row.id)
      return {
        id: row.id,
        status: row.status as BackupView['status'],
        trigger: row.trigger as BackupView['trigger'],
        destination: destinations.find((item) => item.id === row.destinationId) ?? null,
        location: row.location,
        encrypted: row.encrypted,
        items: row.items as BackupItem[],
        sizeBytes: row.sizeBytes,
        username: row.username,
        error: row.error,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        lastRestore: restore ? toRestoreView(restore) : null,
      }
    })
  }

  app.get(base, viewer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    let candidates: BackupPlanPage['candidates'] = []
    let dockerError: string | null = null
    try {
      candidates = await service.candidates(found.project.slug, found.env.slug)
    } catch (error) {
      dockerError = `Docker injoignable : ${error instanceof Error ? error.message : String(error)}`
    }
    const rows = await db
      .select()
      .from(backups)
      .where(eq(backups.environmentId, params.envId))
      .orderBy(desc(backups.startedAt))
      .limit(50)
    return {
      plan: await planView(params.envId),
      candidates,
      dockerError,
      backups: await backupViews(rows),
    }
  })

  /** Destinations proposées dans le formulaire du plan (sans détails ni secrets). */
  app.get('/backup-destinations', viewer, async () =>
    (await destinationViews()).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      encrypted: item.encrypted,
    })),
  )

  app.put(`${base}/plan`, admin, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    const input = params && parseInput(backupPlanInputSchema, request.body, reply)
    if (!params || !input) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    const [destination] = await db
      .select({ id: backupDestinations.id })
      .from(backupDestinations)
      .where(eq(backupDestinations.id, input.destinationId))
    if (!destination) {
      return reply.code(400).send({ error: 'Destination introuvable', field: 'destinationId' })
    }
    const values = {
      destinationId: input.destinationId,
      enabled: input.enabled,
      schedule: input.schedule,
      keep: input.keep,
      selection: input.selection,
      nextRunAt: input.enabled ? nextRun(input.schedule, new Date()) : null,
    }
    await db
      .insert(backupPlans)
      .values({ environmentId: params.envId, ...values })
      .onConflictDoUpdate({ target: backupPlans.environmentId, set: values })
    await auditAction(db, request, 'backup.plan', `${found.project.slug}/${found.env.slug}`, {
      enabled: input.enabled,
      schedule: input.schedule,
      keep: input.keep,
    })
    return planView(params.envId)
  })

  app.delete(`${base}/plan`, admin, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    await db.delete(backupPlans).where(eq(backupPlans.environmentId, params.envId))
    await auditAction(db, request, 'backup.plan.delete', `${found.project.slug}/${found.env.slug}`)
    return reply.code(204).send()
  })

  app.post(base, deployer, async (request, reply) => {
    const params = parseInput(envParams, request.params, reply)
    if (!params) return
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return reply.code(404).send({ error: 'Environnement introuvable' })
    try {
      const id = await service.request(params.envId, 'manual', request.user ?? null)
      return reply.code(202).send({ id })
    } catch (error) {
      return fail(reply, error)
    }
  })

  async function findBackup(params: z.infer<typeof backupParams>) {
    const found = await findEnvironment(params.id, params.envId)
    if (!found) return null
    const [row] = await db
      .select()
      .from(backups)
      .where(and(eq(backups.id, params.backupId), eq(backups.environmentId, params.envId)))
    return row ? { ...found, backup: row } : null
  }

  app.get(`${base}/:backupId`, viewer, async (request, reply) => {
    const params = parseInput(backupParams, request.params, reply)
    if (!params) return
    const found = await findBackup(params)
    if (!found) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    const [view] = await backupViews([found.backup])
    const [restore] = await db
      .select()
      .from(backupRestores)
      .where(eq(backupRestores.backupId, params.backupId))
      .orderBy(desc(backupRestores.startedAt))
      .limit(1)
    return { ...view, logs: found.backup.logs, restoreLogs: restore?.logs ?? [] }
  })

  app.post(`${base}/:backupId/restore`, admin, async (request, reply) => {
    const params = parseInput(backupParams, request.params, reply)
    const input = params && parseInput(backupRestoreInputSchema, request.body, reply)
    if (!params || !input) return
    const found = await findBackup(params)
    if (!found) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    if (input.confirm.trim() !== found.project.name) {
      return reply
        .code(400)
        .send({ error: 'Retapez le nom du projet pour confirmer', field: 'confirm' })
    }
    try {
      const id = await service.requestRestore(params.backupId, input.items, request.user ?? null)
      await auditAction(
        db,
        request,
        'backup.restore.request',
        `${found.project.slug}/${found.env.slug}`,
        { backupId: params.backupId, items: input.items },
      )
      return reply.code(202).send({ id })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get(`${base}/:backupId/download`, admin, async (request, reply) => {
    const params = parseInput(backupParams, request.params, reply)
    const query =
      params && parseInput(z.object({ item: z.string().max(300) }), request.query, reply)
    if (!params || !query) return
    const found = await findBackup(params)
    if (!found) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    try {
      const { stream, name } = await service.download(params.backupId, query.item)
      await auditAction(db, request, 'backup.download', `${found.project.slug}/${found.env.slug}`, {
        backupId: params.backupId,
        item: query.item,
      })
      const date = found.backup.startedAt.toISOString().slice(0, 10)
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="${`${found.project.slug}-${found.env.slug}-${date}-${name}`.replace(/[^\w.-]/g, '_')}"`,
        )
        .send(stream)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete(`${base}/:backupId`, admin, async (request, reply) => {
    const params = parseInput(backupParams, request.params, reply)
    if (!params) return
    const found = await findBackup(params)
    if (!found) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    try {
      await service.remove(params.backupId)
    } catch (error) {
      return fail(reply, error)
    }
    await auditAction(db, request, 'backup.delete', `${found.project.slug}/${found.env.slug}`, {
      backupId: params.backupId,
    })
    return reply.code(204).send()
  })

  // --- Sauvegarde de Vercio (sa propre base) -----------------------------------------------

  const vercioBase = '/settings/backups/vercio'
  const vercioParams = z.object({ backupId: z.uuid() })

  async function vercioPlanView(): Promise<BackupPlanView | null> {
    const plan = await service.vercioPlan()
    if (!plan) return null
    const [destination] = await db
      .select()
      .from(backupDestinations)
      .where(eq(backupDestinations.id, plan.destinationId))
    return {
      enabled: plan.enabled,
      destination: destination
        ? { id: destination.id, name: destination.name, encrypted: !!destination.passphraseEnc }
        : null,
      schedule: plan.schedule,
      keep: plan.keep,
      selection: {},
      nextRunAt: plan.enabled ? plan.nextRunAt : null,
    }
  }

  async function findVercioBackup(backupId: string) {
    const [row] = await db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), isNull(backups.environmentId)))
    return row ?? null
  }

  app.get(vercioBase, admin, async (): Promise<VercioBackupPage> => {
    const rows = await db
      .select()
      .from(backups)
      .where(isNull(backups.environmentId))
      .orderBy(desc(backups.startedAt))
      .limit(50)
    return {
      plan: await vercioPlanView(),
      backups: await backupViews(rows),
      restore: service.vercioRestore,
    }
  })

  app.put(`${vercioBase}/plan`, admin, async (request, reply) => {
    const input = parseInput(vercioBackupPlanInputSchema, request.body, reply)
    if (!input) return
    const [destination] = await db
      .select({ id: backupDestinations.id })
      .from(backupDestinations)
      .where(eq(backupDestinations.id, input.destinationId))
    if (!destination) {
      return reply.code(400).send({ error: 'Destination introuvable', field: 'destinationId' })
    }
    await service.saveVercioPlan({
      ...input,
      nextRunAt: input.enabled ? nextRun(input.schedule, new Date()).toISOString() : null,
    })
    await auditAction(db, request, 'backup.plan', 'vercio', {
      enabled: input.enabled,
      schedule: input.schedule,
      keep: input.keep,
    })
    return vercioPlanView()
  })

  app.delete(`${vercioBase}/plan`, admin, async (request, reply) => {
    await service.saveVercioPlan(null)
    await auditAction(db, request, 'backup.plan.delete', 'vercio')
    return reply.code(204).send()
  })

  app.post(vercioBase, admin, async (request, reply) => {
    try {
      return reply
        .code(202)
        .send({ id: await service.requestVercio('manual', request.user ?? null) })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post(`${vercioBase}/:backupId/restore`, admin, async (request, reply) => {
    const params = parseInput(vercioParams, request.params, reply)
    const input = params && parseInput(vercioRestoreInputSchema, request.body, reply)
    if (!params || !input) return
    try {
      await service.requestVercioRestore(params.backupId, request.user ?? null)
    } catch (error) {
      return fail(reply, error)
    }
    await auditAction(db, request, 'backup.restore.request', 'vercio', {
      backupId: params.backupId,
    })
    return reply.code(202).send({ ok: true })
  })

  app.get(`${vercioBase}/:backupId`, admin, async (request, reply) => {
    const params = parseInput(vercioParams, request.params, reply)
    if (!params) return
    const row = await findVercioBackup(params.backupId)
    if (!row) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    const [view] = await backupViews([row])
    return { ...view, logs: row.logs, restoreLogs: [] }
  })

  app.get(`${vercioBase}/:backupId/download`, admin, async (request, reply) => {
    const params = parseInput(vercioParams, request.params, reply)
    const query =
      params && parseInput(z.object({ item: z.string().max(300) }), request.query, reply)
    if (!params || !query) return
    const row = await findVercioBackup(params.backupId)
    if (!row) return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    try {
      const { stream, name } = await service.download(params.backupId, query.item)
      await auditAction(db, request, 'backup.download', 'vercio', {
        backupId: params.backupId,
        item: query.item,
      })
      const date = row.startedAt.toISOString().slice(0, 10)
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="${`vercio-${date}-${name}`.replace(/[^\w.-]/g, '_')}"`,
        )
        .send(stream)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.delete(`${vercioBase}/:backupId`, admin, async (request, reply) => {
    const params = parseInput(vercioParams, request.params, reply)
    if (!params) return
    if (!(await findVercioBackup(params.backupId))) {
      return reply.code(404).send({ error: 'Sauvegarde introuvable' })
    }
    try {
      await service.remove(params.backupId)
    } catch (error) {
      return fail(reply, error)
    }
    await auditAction(db, request, 'backup.delete', 'vercio', { backupId: params.backupId })
    return reply.code(204).send()
  })
}
