import { describe, expect, it } from 'vitest'
import { SecretBox, hashToken, randomToken } from '../src/lib/crypto.js'

const KEY = 'test-key-with-at-least-thirty-two-characters'

describe('SecretBox', () => {
  it('chiffre puis déchiffre', () => {
    const box = new SecretBox(KEY)
    const payload = box.encrypt('glpat-secret-token')
    expect(payload).not.toContain('glpat')
    expect(box.decrypt(payload)).toBe('glpat-secret-token')
  })

  it('produit un chiffré différent à chaque appel', () => {
    const box = new SecretBox(KEY)
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'))
  })

  it('refuse une autre clé', () => {
    const payload = new SecretBox(KEY).encrypt('secret')
    expect(() => new SecretBox(`${KEY}-autre`).decrypt(payload)).toThrow()
  })

  it('détecte une altération', () => {
    const box = new SecretBox(KEY)
    const parts = box.encrypt('secret').split(':')
    parts[3] = Buffer.from('falsifie').toString('base64url')
    expect(() => box.decrypt(parts.join(':'))).toThrow()
  })

  it('gère la chaîne vide', () => {
    const box = new SecretBox(KEY)
    expect(box.decrypt(box.encrypt(''))).toBe('')
  })
})

describe('jetons', () => {
  it('génère des jetons uniques et une empreinte stable', () => {
    const token = randomToken()
    expect(token).toHaveLength(43)
    expect(randomToken()).not.toBe(token)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(token)
  })
})
