import type { FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { hasRole, type Role, type SessionUser } from '@vercio/shared'
import { sessionCookieName, type SessionStore } from './sessions.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
  interface FastifyInstance {
    requireRole: (role: Role) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Résout l'utilisateur depuis le cookie de session et protège contre le CSRF :
 * toute requête modifiante authentifiée par cookie doit venir de l'origine publique de Vercio.
 */
export const authPlugin = fp<{ sessions: SessionStore; publicOrigin: string }>(
  async (app, { sessions, publicOrigin }) => {
    app.decorateRequest('user', null)
    const cookieName = sessionCookieName(publicOrigin.startsWith('https:'))

    app.addHook('onRequest', async (request, reply) => {
      const token = request.cookies[cookieName]
      if (!token) return

      if (!SAFE_METHODS.has(request.method)) {
        const origin = request.headers.origin
        if (origin !== publicOrigin) {
          return reply.code(403).send({ error: 'Origine de la requête refusée' })
        }
      }
      request.user = await sessions.resolve(token)
    })

    app.decorate('requireRole', (role: Role) => async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentification requise' })
      }
      if (!hasRole(request.user.roles, role)) {
        return reply.code(403).send({ error: 'Droits insuffisants' })
      }
    })
  },
)
