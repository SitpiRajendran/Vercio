import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { httpRequest } from '../src/lib/http.js'
import { outboundDispatcher } from '../src/notifications/outbound.js'

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

describe('Notifications sortantes : contrôle à la connexion', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    // Le contrôle ne s'applique pas derrière un proxy d'entreprise : on le retire pour le test.
    for (const name of PROXY_VARS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
  })
  afterEach(() => {
    for (const name of PROXY_VARS) if (saved[name] !== undefined) process.env[name] = saved[name]
  })

  it('refuse un nom qui pointe vers la machine de Vercio au moment de la connexion', async () => {
    const server = createServer((_request, response) => response.end('interne'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      // `localhost` simule un nom dont le DNS a changé après la vérification de l'URL.
      const error = await httpRequest(
        `http://localhost:${port}/`,
        {},
        { dispatcher: outboundDispatcher(false) },
      ).catch((cause: unknown) => cause as { cause?: { code?: string } })
      expect((error as { cause?: { code?: string } }).cause?.code).toBe('EFORBIDDEN')
      // Récepteur local autorisé (tests, développement) : la connexion passe.
      const allowed = await httpRequest(
        `http://localhost:${port}/`,
        {},
        { dispatcher: outboundDispatcher(true) },
      )
      expect(await allowed.text()).toBe('interne')
    } finally {
      server.close()
    }
  })
})
