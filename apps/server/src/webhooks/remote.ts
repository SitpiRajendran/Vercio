import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/client.js'
import { appSources, environmentSources, gitProviders } from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { gitProviderClient } from '../providers/git.js'

/** Fournisseur Git et dépôt d'une source, avec le token en clair. */
async function sourceAccess(db: Database, box: SecretBox, appSourceId: string) {
  const [row] = await db
    .select({ source: appSources, provider: gitProviders })
    .from(appSources)
    .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
    .where(eq(appSources.id, appSourceId))
    .limit(1)
  if (!row) return null
  return {
    repository: row.source.repository,
    type: row.provider.type,
    client: gitProviderClient({
      type: row.provider.type,
      url: row.provider.webUrl,
      token: box.decrypt(row.provider.tokenEnc),
      caCertificate: row.provider.caCertificate,
    }),
  }
}

/**
 * Crée (ou met à jour) chez GitLab / GitHub le webhook d'un environnement pour une source :
 * URL native du fournisseur, secret de l'environnement, évènements de fin de pipeline.
 */
export async function installRemoteWebhook(
  db: Database,
  box: SecretBox,
  publicUrl: URL,
  environmentId: string,
  appSourceId: string,
): Promise<{ pageUrl: string }> {
  const [envSource] = await db
    .select()
    .from(environmentSources)
    .where(
      and(
        eq(environmentSources.environmentId, environmentId),
        eq(environmentSources.appSourceId, appSourceId),
      ),
    )
    .limit(1)
  if (!envSource?.webhookTokenEnc || !envSource.webhookSecretEnc) {
    throw new Error('Aucune URL de webhook pour cette source : régénérez-la d’abord')
  }
  const access = await sourceAccess(db, box, appSourceId)
  if (!access) throw new Error('Dépôt introuvable')
  const token = box.decrypt(envSource.webhookTokenEnc)
  const { id } = await access.client.installWebhook(access.repository, {
    url: new URL(`/api/hooks/${access.type}/${token}`, publicUrl).href,
    secret: box.decrypt(envSource.webhookSecretEnc),
    existingId: envSource.webhookRemoteId,
  })
  await db
    .update(environmentSources)
    .set({ webhookRemoteId: id, webhookInstalledAt: new Date() })
    .where(
      and(
        eq(environmentSources.environmentId, environmentId),
        eq(environmentSources.appSourceId, appSourceId),
      ),
    )
  return { pageUrl: access.client.webhooksPageUrl(access.repository) }
}

/**
 * Supprime chez le fournisseur les webhooks créés par Vercio pour ces environnements
 * (environnement ou projet supprimé). Au mieux : un échec est journalisé, jamais bloquant.
 */
export async function removeRemoteWebhooks(
  db: Database,
  box: SecretBox,
  environmentIds: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (!environmentIds.length) return
  const rows = await db
    .select()
    .from(environmentSources)
    .where(
      and(
        inArray(environmentSources.environmentId, environmentIds),
        isNotNull(environmentSources.webhookRemoteId),
      ),
    )
  for (const row of rows) {
    try {
      const access = await sourceAccess(db, box, row.appSourceId)
      if (access) await access.client.removeWebhook(access.repository, row.webhookRemoteId!)
    } catch (error) {
      log.warn({ err: error, appSourceId: row.appSourceId }, 'Webhook distant non supprimé')
    }
  }
}
