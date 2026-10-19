import { describe, expect, it } from 'vitest'
import { defaultImageRegistry } from '../src/settings.js'

describe('Registry d’images d’une instance Git', () => {
  it('déduit l’adresse du registry', () => {
    expect(defaultImageRegistry('gitlab', 'https://gitlab.com')).toBe('registry.gitlab.com')
    expect(defaultImageRegistry('gitlab', 'https://git.example.com/')).toBe(
      'registry.git.example.com',
    )
    expect(defaultImageRegistry('github', 'https://github.com')).toBe('ghcr.io')
    expect(defaultImageRegistry('github', 'https://github.example.com')).toBe(
      'containers.github.example.com',
    )
  })
})
