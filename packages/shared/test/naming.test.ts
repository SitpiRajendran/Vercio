import { describe, expect, it } from 'vitest'
import {
  composeProjectName,
  isVersionTag,
  channelTag,
  commitImageTag,
  latestTagForBranch,
  slugify,
  slugSchema,
} from '../src/naming.js'
import { hasRole } from '../src/auth.js'

describe('slugify', () => {
  it('normalise accents, espaces et majuscules', () => {
    expect(slugify('  Site Été — Prod ')).toBe('site-ete-prod')
  })
  it('produit un slug valide', () => {
    expect(slugSchema.safeParse(slugify('Mon Projet #1')).success).toBe(true)
  })
})

describe('slugSchema', () => {
  it('refuse les caractères dangereux', () => {
    for (const bad of ['a;b', 'A', '../x', 'a b', '-a', 'a-', '']) {
      expect(slugSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('versions', () => {
  it('reconnaît vX.Y et vX.Y.Z', () => {
    expect(isVersionTag('v0.1')).toBe(true)
    expect(isVersionTag('v1.4.2')).toBe(true)
    expect(isVersionTag('1.4.2')).toBe(false)
    expect(isVersionTag('v1')).toBe(false)
    expect(isVersionTag('latest')).toBe(false)
  })
  it('nomme le canal latest par branche', () => {
    expect(latestTagForBranch('main', 'main')).toBe('latest')
    expect(latestTagForBranch('develop', 'main')).toBe('develop-latest')
    expect(latestTagForBranch('feature/x', 'main')).toBe('feature-x-latest')
  })
  it('nomme le projet compose', () => {
    expect(composeProjectName('site', 'prod')).toBe('vercio_site_prod')
  })
})

describe('hasRole', () => {
  it('applique la hiérarchie des rôles', () => {
    expect(hasRole(['vercio-admin'], 'vercio-deployer')).toBe(true)
    expect(hasRole(['vercio-viewer'], 'vercio-deployer')).toBe(false)
    expect(hasRole([], 'vercio-viewer')).toBe(false)
  })
})

describe('parseImageReference', async () => {
  const { parseImageReference } = await import('../src/projects.js')
  it('distingue hôte, chemin et tag comme Docker', () => {
    expect(parseImageReference('registry.gitlab.com/groupe/site/front:v1.2')).toEqual({
      host: 'registry.gitlab.com',
      path: 'groupe/site/front',
      tag: 'v1.2',
    })
    expect(parseImageReference('localhost:5000/app')).toEqual({
      host: 'localhost:5000',
      path: 'app',
      tag: null,
    })
    expect(parseImageReference('postgres:17')).toEqual({ host: null, path: 'postgres', tag: '17' })
    expect(parseImageReference('bitnami/redis')).toEqual({
      host: null,
      path: 'bitnami/redis',
      tag: null,
    })
    expect(parseImageReference('ghcr.io/o/r@sha256:abc')).toEqual({
      host: 'ghcr.io',
      path: 'o/r',
      tag: 'sha256:abc',
    })
  })
})

describe('Convention de tags', () => {
  const vercio = { defaultBranch: 'main', latestTagName: 'latest', latestTagTemplate: null }

  it('suit la convention de Vercio par défaut', () => {
    expect(channelTag('main', vercio)).toBe('latest')
    expect(channelTag('feature/x', vercio)).toBe('feature-x-latest')
  })

  it('applique un modèle personnalisé', () => {
    const custom = { ...vercio, latestTagTemplate: '{branch}' }
    expect(channelTag('prod', custom)).toBe('prod')
    expect(channelTag('release/2026', custom)).toBe('release-2026')
    expect(channelTag('main', { ...vercio, latestTagTemplate: 'stable' })).toBe('stable')
  })

  it('nomme l’image d’un commit', () => {
    const sha = 'd4f61051a9b2c3d4e5f60718293a4b5c6d7e8f90'
    expect(commitImageTag('{sha:8}', sha)).toBe('d4f61051')
    expect(commitImageTag('sha-{sha:7}', sha)).toBe('sha-d4f6105')
    expect(commitImageTag('{sha}', sha)).toBe(sha)
  })
})
