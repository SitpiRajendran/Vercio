import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { gitProviders } from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { gitProviderClient } from './git.js'
import { OciRegistryClient } from './registry.js'

export interface RegistryAccess {
  url: string
  username?: string | null
  /** Mot de passe en clair (déjà déchiffré), ou absent. */
  password?: string | null
  gitProviderId?: string | null
  insecure: boolean
  caCertificate?: string | null
}

/**
 * Client d'un registry avec ses identifiants effectifs : ceux du registry, sinon (registry GitLab
 * ou GHCR) le token du fournisseur Git lié et le compte associé à ce token.
 */
export async function registryClientFor(
  db: Database,
  box: SecretBox,
  access: RegistryAccess,
): Promise<OciRegistryClient> {
  const { username, password } = await resolveRegistryCredentials(db, box, access)
  return new OciRegistryClient({
    url: access.url,
    username,
    password,
    insecure: access.insecure,
    caCertificate: access.caCertificate,
  })
}

/** Identifiants effectifs d'un registry (pour son API comme pour `docker pull`). */
export async function resolveRegistryCredentials(
  db: Database,
  box: SecretBox,
  access: RegistryAccess,
): Promise<{ username: string | null; password: string | null }> {
  let username = access.username ?? null
  let password = access.password ?? null
  if (!password && access.gitProviderId) {
    const [provider] = await db
      .select()
      .from(gitProviders)
      .where(eq(gitProviders.id, access.gitProviderId))
      .limit(1)
    if (provider) {
      password = box.decrypt(provider.tokenEnc)
      if (!username) {
        username = await gitProviderClient({
          type: provider.type,
          url: provider.webUrl,
          token: password,
          caCertificate: provider.caCertificate,
        }).accountName()
      }
    }
  }
  return { username, password }
}
