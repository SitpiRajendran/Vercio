import {
  commitImageTag,
  type ImageVersion,
  type VersionChoices,
  type VersionTag,
} from '@vercio/shared'
import type { GitTag } from '../providers/git.js'
import type { ImageTagInfo } from '../providers/registry.js'

export interface ResolverDeps {
  listTags(): Promise<GitTag[]>
  /** Derniers commits de la branche (versions par commit). */
  listCommits(limit: number): Promise<GitTag[]>
  commitDetails(sha: string): Promise<Partial<GitTag>>
  isOnBranch(sha: string): Promise<boolean>
  /** Image d'un service pour un tag, ou null si absente. Une exception = registry en erreur. */
  imageTag(serviceName: string, tag: string): Promise<ImageTagInfo | null>
  commitUrl(sha: string): string
  pipelineUrl(ref: string): string
}

export interface ResolverOptions {
  appSourceId: string
  branch: string
  latestTag: string
  tagPattern: RegExp
  /** Versions proposées : tags Git, ou derniers commits dont l'image existe. */
  versionSource?: 'git_tags' | 'commits'
  /** Tag d'image d'un commit (`{sha:8}`…), pour `versionSource = commits`. */
  commitTagTemplate?: string
  /** Services suivis rattachés à cette source. */
  services: string[]
  limit?: number
  /** Nombre maximal de tags examinés (chaque tag coûte des appels au fournisseur et au registry). */
  maxCandidates?: number
  maxIncomplete?: number
}

/**
 * Règle du sélecteur de version :
 * tags au format version, dont le commit appartient à la branche, dont toutes les images
 * suivies existent dans le registry, triés par date de push ; on garde les 5 premiers.
 */
export async function resolveVersions(
  deps: ResolverDeps,
  options: ResolverOptions,
): Promise<VersionChoices> {
  const limit = options.limit ?? 5
  const maxCandidates = options.maxCandidates ?? 20
  const maxIncomplete = options.maxIncomplete ?? 3
  const warnings = new Set<string>()

  const images = async (tag: string) => {
    const found: ImageVersion[] = []
    const missing: string[] = []
    await Promise.all(
      options.services.map(async (serviceName) => {
        try {
          const info = await deps.imageTag(serviceName, tag)
          if (info) found.push({ serviceName, digest: info.digest, pushedAt: info.createdAt })
          else missing.push(serviceName)
        } catch (error) {
          warnings.add(error instanceof Error ? error.message : String(error))
          missing.push(serviceName)
        }
      }),
    )
    found.sort((a, b) => a.serviceName.localeCompare(b.serviceName))
    missing.sort()
    const dates = found
      .map((image) => image.pushedAt)
      .filter((date): date is string => Boolean(date))
    return { found, missing, pushedAt: dates.sort().at(-1) ?? null }
  }

  const latestImages = await images(options.latestTag)
  const latest: VersionChoices['latest'] = {
    tag: options.latestTag,
    available: options.services.length > 0 && latestImages.missing.length === 0,
    missing: latestImages.missing,
    pushedAt: latestImages.pushedAt,
    images: latestImages.found,
    version: null,
  }

  const byCommit = options.versionSource === 'commits'
  const candidates = byCommit
    ? // Versions par commit : le tag d'image se déduit du SHA ; le commit est déjà sur la branche.
      (await deps.listCommits(maxCandidates)).map((commit) => ({
        ...commit,
        name: commitImageTag(options.commitTagTemplate ?? '{sha:8}', commit.sha),
      }))
    : orderCandidates((await deps.listTags()).filter((tag) => options.tagPattern.test(tag.name)))
  if (!byCommit && candidates.length > maxCandidates) {
    warnings.add(`Seuls les ${maxCandidates} tags les plus récents ont été examinés.`)
  }

  const complete: VersionTag[] = []
  const incomplete: VersionTag[] = []
  // Par lots de 5 : assez rapide sans saturer les quotas d'API.
  for (let offset = 0; offset < Math.min(candidates.length, maxCandidates); offset += 5) {
    const batch = candidates.slice(offset, Math.min(offset + 5, maxCandidates))
    const results = await Promise.all(
      batch.map(async (tag) => {
        if (!byCommit && !(await deps.isOnBranch(tag.sha).catch(() => false))) return null
        const details =
          tag.message === null ? await deps.commitDetails(tag.sha).catch(() => ({})) : {}
        const commit = { ...tag, ...details }
        const result = await images(tag.name)
        // Commit sans aucune image : la CI ne l'a pas construit (ce n'est pas un build en cours).
        if (byCommit && result.found.length === 0) return null
        const version: VersionTag = {
          name: tag.name,
          commit: {
            sha: tag.sha,
            shortSha: tag.sha.slice(0, 8),
            message: commit.message ?? null,
            author: commit.author ?? null,
            date: commit.date ?? null,
            url: deps.commitUrl(tag.sha),
          },
          pushedAt: result.pushedAt,
          complete: result.missing.length === 0,
          missing: result.missing,
          images: result.found,
          pipelineUrl: deps.pipelineUrl(tag.name),
        }
        return version
      }),
    )
    for (const version of results) {
      if (!version) continue
      if (version.complete) {
        if (complete.length < limit) complete.push(version)
      } else if (complete.length < limit && incomplete.length < maxIncomplete) {
        // Plus récent qu'un tag complet retenu : build en cours ou en échec.
        incomplete.push(version)
      }
    }
    if (complete.length >= limit) break
  }

  const sortKey = (version: VersionTag) => version.pushedAt ?? version.commit.date ?? ''
  // Les plus récents d'abord, `limit` au plus (builds incomplets compris).
  const tags = [...complete, ...incomplete]
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
    .slice(0, limit)

  // Version correspondant au dernier build : même image (digest) pour chaque service.
  if (latest.available) {
    const digests = (version: { images: ImageVersion[] }) =>
      version.images.map((image) => `${image.serviceName}@${image.digest}`).join(',')
    const match = tags.find((tag) => tag.complete && digests(tag) === digests(latest))
    if (match) latest.version = { name: match.name, commit: match.commit }
  }
  return {
    appSourceId: options.appSourceId,
    branch: options.branch,
    versionSource: byCommit ? 'commits' : 'git_tags',
    latest,
    tags,
    warnings: [...warnings],
    checkedAt: new Date().toISOString(),
  }
}

/** Ordre d'examen : date du commit si connue (GitLab), sinon numéro de version décroissant. */
export function orderCandidates(tags: GitTag[]): GitTag[] {
  return [...tags].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date)
    return compareVersions(b.name, a.name)
  })
}

export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .replace(/^v/i, '')
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = Number.isNaN(left[i] ?? 0) ? 0 : (left[i] ?? 0)
    const y = Number.isNaN(right[i] ?? 0) ? 0 : (right[i] ?? 0)
    if (x !== y) return x - y
  }
  return a.localeCompare(b)
}
