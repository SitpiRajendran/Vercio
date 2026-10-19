import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'

/** Valide une entrée ; en cas d'erreur, répond 400 avec le premier problème et son champ. */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  reply
    .code(400)
    .send({ error: issue?.message ?? 'Requête invalide', field: issue?.path.join('.') })
  return null
}

export function auditAction(
  db: Database,
  request: FastifyRequest,
  action: string,
  target: string,
  details?: Record<string, unknown>,
  success = true,
) {
  return audit(db, {
    userId: request.user?.id,
    username: request.user?.username,
    action,
    target,
    ip: request.ip,
    success,
    details,
  })
}

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code
  return code === '23505' || (error as { code?: string })?.code === '23505'
}

/** Erreur métier : renvoyée telle quelle au client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

export function sendHttpError(reply: FastifyReply, error: unknown) {
  if (error instanceof HttpError) {
    return reply.code(error.status).send({ error: error.message, field: error.field })
  }
  throw error
}
