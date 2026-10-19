import { and, eq } from 'drizzle-orm'
import { channelTag, type VersionChoices } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { appSources, gitProviders, registries, trackedServices } from '../db/schema.js'
import type { SecretBox } from '../lib/crypto.js'
import { gitProviderClient } from '../providers/git.js'
import type { OciRegistryClient } from '../providers/registry.js'
import { registryClientFor } from '../providers/registry-access.js'
import { missingImageMessage } from '../providers/registry-diagnostics.js'
import { registryHost } from '../deploy/render.js'
import { resolveVersions } from './resolver.js'

const CACHE_TTL_MS = 60_000

/** Versions disponibles par source et branche, avec un cache court invalidé par les webhooks. */
export class VersionService {
  readonly #cache = new Map<string, { value: VersionChoices; expiresAt: number }>()

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  invalidate(appSourceId: string): void {
    for (const key of this.#cache.keys()) {
      if (key.startsWith(`${appSourceId}|`)) this.#cache.delete(key)
    }
  }

  async choices(
    appSourceId: string,
    branch: string,
    refresh = false,
  ): Promise<VersionChoices | null> {
    const key = `${appSourceId}|${branch}`
    const cached = this.#cache.get(key)
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value

    const [row] = await this.db
      .select({ source: appSources, provider: gitProviders })
      .from(appSources)
      .innerJoin(gitProviders, eq(gitProviders.id, appSources.gitProviderId))
      .where(eq(appSources.id, appSourceId))
      .limit(1)
    if (!row) return null
    const { source, provider } = row

    const git = gitProviderClient({
      type: provider.type,
      url: provider.webUrl,
      token: this.box.decrypt(provider.tokenEnc),
      caCertificate: provider.caCertificate,
    })

    const tracked = await this.db
      .select({ service: trackedServices, registry: registries })
      .from(trackedServices)
      .innerJoin(registries, eq(registries.id, trackedServices.registryId))
      .where(and(eq(trackedServices.appSourceId, source.id)))
    const clients = new Map<string, Promise<OciRegistryClient>>()
    const clientFor = (registry: typeof registries.$inferSelect) => {
      if (!clients.has(registry.id)) {
        clients.set(
          registry.id,
          registryClientFor(this.db, this.box, {
            ...registry,
            password: registry.passwordEnc ? this.box.decrypt(registry.passwordEnc) : null,
          }),
        )
      }
      return clients.get(registry.id)!
    }

    let tagPattern: RegExp
    try {
      tagPattern = new RegExp(source.tagPattern)
    } catch {
      tagPattern = /^v\d+\.\d+(\.\d+)?$/
    }
    const latestTag = channelTag(branch, source)

    const value = await resolveVersions(
      {
        listTags: () => git.listTags(source.repository),
        listCommits: (limit) => git.listCommits(source.repository, branch, limit),
        commitDetails: (sha) => git.commitDetails(source.repository, sha),
        isOnBranch: (sha) => git.isCommitOnBranch(source.repository, sha, branch),
        imageTag: async (serviceName, tag) => {
          const entry = tracked.find((item) => item.service.serviceName === serviceName)!
          const client = await clientFor(entry.registry)
          return client.getTag(entry.service.imageRepository, tag)
        },
        commitUrl: (sha) => git.commitUrl(source.repository, sha),
        pipelineUrl: (ref) => git.pipelineUrl(source.repository, ref),
      },
      {
        appSourceId: source.id,
        branch,
        latestTag,
        tagPattern,
        versionSource: source.versionSource,
        commitTagTemplate: source.commitTagTemplate,
        services: tracked.map((item) => item.service.serviceName),
      },
    )
    // `latest` absent : on explique pourquoi (chemin d'image faux ou tag jamais poussé).
    for (const serviceName of value.latest.missing) {
      const entry = tracked.find((item) => item.service.serviceName === serviceName)
      if (!entry) continue
      value.warnings.push(
        await missingImageMessage(await clientFor(entry.registry), {
          service: serviceName,
          registryName: entry.registry.name,
          image: `${registryHost(entry.registry.url)}/${entry.service.imageRepository}`,
          path: entry.service.imageRepository,
          tag: latestTag,
        }),
      )
    }
    this.#cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }
}
