import { describe, expect, it } from 'vitest'
import { composeCandidates, defaultComposeFile } from '../src/projects.js'

describe('Fichiers Compose d’un dépôt', () => {
  const tree = [
    '.github/workflows/ci.yml',
    '.gitlab-ci.yml',
    '.gitguardian.yaml',
    'pnpm-lock.yaml',
    'config/app.yaml',
    'deploy/compose.prod.yml',
    'docker-compose.dev.yml',
    'node_modules/x/compose.yml',
    'README.md',
  ]

  it('garde les YAML possibles, ceux nommés « compose » d’abord', () => {
    expect(composeCandidates(tree)).toEqual([
      'docker-compose.dev.yml',
      'deploy/compose.prod.yml',
      'config/app.yaml',
    ])
  })

  it('détecte le fichier Compose standard à la racine', () => {
    expect(defaultComposeFile(['docker-compose.yml', 'compose.yaml'])).toBe('compose.yaml')
    expect(defaultComposeFile(composeCandidates(tree))).toBeNull()
  })
})
