import { describe, expect, it } from 'vitest'
import { acquireInstanceLock, connectionName, createDatabase } from '../src/db/client.js'
import { TEST_DATABASE_URL } from './helpers.js'

describe.skipIf(!TEST_DATABASE_URL)('Une seule instance par base', () => {
  it('refuse une seconde instance tant que la première tourne', async () => {
    // Autre machine : l'instance est peut-être bien vivante, on ne la touche pas.
    const first = createDatabase(TEST_DATABASE_URL!, {
      applicationName: connectionName('autre-hote', 4242),
    })
    const second = createDatabase(TEST_DATABASE_URL!)
    const messages: string[] = []
    try {
      const release = await acquireInstanceLock(first.sql)
      await expect(
        acquireInstanceLock(second.sql, {
          timeoutMs: 300,
          intervalMs: 100,
          onWait: (message) => messages.push(message),
        }),
      ).rejects.toThrow(
        'une autre instance de Vercio utilise déjà cette base de données (vercio:autre-hote:4242',
      )
      expect(messages[0]).toContain('attente de son arrêt')
      await release()
      const releaseSecond = await acquireInstanceLock(second.sql, { timeoutMs: 300 })
      await releaseSecond()
    } finally {
      await first.sql.end()
      await second.sql.end()
    }
  })

  it('ferme la connexion laissée par une instance arrêtée de cette machine', async () => {
    // Processus qui n'existe plus (redémarrage de `pnpm dev`, processus tué).
    const stale = createDatabase(TEST_DATABASE_URL!, {
      applicationName: connectionName(undefined, 2 ** 22 + 12345),
    })
    const next = createDatabase(TEST_DATABASE_URL!)
    const messages: string[] = []
    try {
      await acquireInstanceLock(stale.sql)
      const release = await acquireInstanceLock(next.sql, {
        timeoutMs: 300,
        onWait: (message) => messages.push(message),
      })
      expect(messages[0]).toContain('instance arrêtée')
      await release()
    } finally {
      await stale.sql.end({ timeout: 1 }).catch(() => {})
      await next.sql.end()
    }
  })
})
