import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  orderCandidates,
  resolveVersions,
  type ResolverDeps,
} from '../src/versions/resolver.js'
import type { GitTag } from '../src/providers/git.js'

const tag = (name: string, sha: string, date: string | null = null): GitTag => ({
  name,
  sha,
  message: date ? `release ${name}` : null,
  author: date ? 'Alice' : null,
  date,
})

/** Dépôt de test : tags, branches et images du registry. */
function fakeDeps(options: {
  tags: GitTag[]
  onBranch: string[]
  images: Record<string, string[]>
  pushedAt?: Record<string, string>
  failingService?: string
  commits?: GitTag[]
  /** Tags poussés sur la même image (même digest), ex. { latest: 'v1.3' }. */
  aliases?: Record<string, string>
}): ResolverDeps & { calls: { isOnBranch: number } } {
  const calls = { isOnBranch: 0 }
  return {
    calls,
    listTags: async () => options.tags,
    listCommits: async (limit) => (options.commits ?? []).slice(0, limit),
    commitDetails: async (sha) => ({
      message: `commit ${sha}`,
      author: 'Bob',
      date: '2026-01-01T00:00:00Z',
    }),
    isOnBranch: async (sha) => {
      calls.isOnBranch++
      return options.onBranch.includes(sha)
    },
    imageTag: async (service, name) => {
      if (service === options.failingService) throw new Error(`Accès refusé à l’image ${service}`)
      const image = options.aliases?.[name] ?? name
      return options.images[name]?.includes(service)
        ? { digest: `sha256:${service}-${image}`, createdAt: options.pushedAt?.[name] ?? null }
        : null
    },
    commitUrl: (sha) => `https://git/commit/${sha}`,
    pipelineUrl: (ref) => `https://git/pipelines?ref=${ref}`,
  }
}

const base = {
  appSourceId: 'src',
  branch: 'main',
  latestTag: 'latest',
  tagPattern: /^v\d+\.\d+(\.\d+)?$/,
  services: ['back', 'front'],
}

describe('compareVersions', () => {
  it('compare numériquement', () => {
    expect(compareVersions('v1.10.0', 'v1.9.3')).toBeGreaterThan(0)
    expect(compareVersions('v0.1', 'v0.1.1')).toBeLessThan(0)
    const ordered = orderCandidates([tag('v1.2', 'a'), tag('v1.10', 'b'), tag('v1.9.1', 'c')])
    expect(ordered.map((t) => t.name)).toEqual(['v1.10', 'v1.9.1', 'v1.2'])
  })
})

describe('resolveVersions', () => {
  it('garde les 5 derniers tags complets de la branche, triés par date de push', async () => {
    const names = ['v1.0', 'v1.1', 'v1.2', 'v1.3', 'v1.4', 'v1.5', 'v1.6']
    const deps = fakeDeps({
      tags: [...names.map((n, i) => tag(n, `sha${i}`)), tag('nightly', 'x'), tag('v2.0-rc', 'y')],
      onBranch: names.map((_, i) => `sha${i}`),
      images: Object.fromEntries([...names, 'latest'].map((n) => [n, ['front', 'back']])),
      // v1.3 a été reconstruit plus tard que v1.6 : il remonte en tête.
      pushedAt: {
        'v1.6': '2026-03-06',
        'v1.5': '2026-03-05',
        'v1.4': '2026-03-04',
        'v1.3': '2026-03-10',
        'v1.2': '2026-03-02',
      },
    })
    const result = await resolveVersions(deps, base)
    expect(result.latest).toMatchObject({ tag: 'latest', available: true, missing: [] })
    expect(result.tags.map((t) => t.name)).toEqual(['v1.3', 'v1.6', 'v1.5', 'v1.4', 'v1.2'])
    expect(result.tags.every((t) => t.complete)).toBe(true)
    expect(result.tags[0]!.commit).toMatchObject({
      shortSha: 'sha3',
      message: 'commit sha3',
      author: 'Bob',
    })
    expect(result.tags[0]!.images.map((i) => i.digest)).toEqual([
      'sha256:back-v1.3',
      'sha256:front-v1.3',
    ])
    expect(result.tags[0]!.pipelineUrl).toBe('https://git/pipelines?ref=v1.3')
  })

  it('écarte les tags d’autres branches et signale les builds incomplets', async () => {
    const deps = fakeDeps({
      tags: [
        tag('v2.1', 'd', '2026-04-04'),
        tag('v2.0', 'c', '2026-04-03'),
        tag('v1.9', 'b', '2026-04-02'),
        tag('v1.8', 'a', '2026-04-01'),
      ],
      onBranch: ['d', 'b', 'a'], // v2.0 est sur une autre branche
      images: { 'v2.1': ['front'], 'v1.9': ['front', 'back'], 'v1.8': ['front', 'back'] },
    })
    const result = await resolveVersions(deps, base)
    expect(result.tags.map((t) => [t.name, t.complete, t.missing])).toEqual([
      ['v2.1', false, ['back']],
      ['v1.9', true, []],
      ['v1.8', true, []],
    ])
    expect(result.latest).toMatchObject({ available: false, missing: ['back', 'front'] })
  })

  it('limite le nombre de tags examinés', async () => {
    const tags = Array.from({ length: 40 }, (_, i) => tag(`v1.${i}`, `s${i}`))
    const deps = fakeDeps({ tags, onBranch: [], images: {} })
    const result = await resolveVersions(deps, { ...base, maxCandidates: 20 })
    expect(deps.calls.isOnBranch).toBe(20)
    expect(result.warnings).toContain('Seuls les 20 tags les plus récents ont été examinés.')
  })

  it('remonte les erreurs du registry sans bloquer', async () => {
    const deps = fakeDeps({
      tags: [tag('v1.0', 'a', '2026-01-01')],
      onBranch: ['a'],
      images: { 'v1.0': ['front', 'back'] },
      failingService: 'back',
    })
    const result = await resolveVersions(deps, base)
    expect(result.tags[0]).toMatchObject({ complete: false, missing: ['back'] })
    expect(result.warnings).toContain('Accès refusé à l’image back')
  })

  it('sans service suivi, liste les tags de la branche', async () => {
    const deps = fakeDeps({ tags: [tag('v1.0', 'a', '2026-01-01')], onBranch: ['a'], images: {} })
    const result = await resolveVersions(deps, { ...base, services: [] })
    expect(result.tags).toHaveLength(1)
    expect(result.tags[0]!.complete).toBe(true)
    expect(result.latest.available).toBe(false)
  })
})

describe('Versions par commit et dernier build', () => {
  const sha = (n: number) => `${n}`.repeat(40).slice(0, 40)
  const commit = (n: number) => ({
    name: sha(n),
    sha: sha(n),
    message: `commit ${n}`,
    author: 'Alice',
    date: `2026-03-0${n}T10:00:00Z`,
  })

  it('propose les derniers commits construits, le tag de l’image venant du SHA', async () => {
    // Commits du plus récent (9) au plus ancien (3) ; le 8 n'a pas été construit par la CI.
    const commits = [9, 8, 7, 6, 5, 4, 3].map(commit)
    const built = [9, 7, 6, 5, 4, 3].map((n) => sha(n).slice(0, 8))
    const images = Object.fromEntries(built.map((tag) => [tag, ['front', 'back']]))
    const result = await resolveVersions(
      fakeDeps({
        tags: [],
        onBranch: [],
        commits,
        images: { ...images, prod: ['front', 'back'] },
        pushedAt: Object.fromEntries(built.map((tag, i) => [tag, `2026-03-0${9 - i}T12:00:00Z`])),
        aliases: { prod: sha(9).slice(0, 8) },
      }),
      { ...base, latestTag: 'prod', versionSource: 'commits', commitTagTemplate: '{sha:8}' },
    )
    expect(result.versionSource).toBe('commits')
    expect(result.tags.map((tag) => tag.name)).toEqual(built.slice(0, 5))
    expect(result.tags[0]!.commit).toMatchObject({ sha: sha(9), message: 'commit 9' })
    // Le dernier build (prod) est l'image du commit 9.
    expect(result.latest.version).toMatchObject({ name: sha(9).slice(0, 8) })
  })

  it('ne propose jamais plus de 5 versions, builds incomplets compris', async () => {
    const tags = ['v1.7', 'v1.6', 'v1.5', 'v1.4', 'v1.3', 'v1.2', 'v1.1'].map((name, i) =>
      tag(name, `s${name}`, `2026-02-0${9 - i}T00:00:00Z`),
    )
    const result = await resolveVersions(
      fakeDeps({
        tags,
        onBranch: tags.map((t) => t.sha),
        // v1.7 : seulement front (build en cours).
        images: Object.fromEntries(
          tags.map((t) => [t.name, t.name === 'v1.7' ? ['front'] : ['front', 'back']]),
        ),
      }),
      base,
    )
    expect(result.tags).toHaveLength(5)
    expect(result.tags.map((t) => t.name)).toEqual(['v1.7', 'v1.6', 'v1.5', 'v1.4', 'v1.3'])
  })
})
