import { describe, expect, it } from 'vitest'
import { MASK, maskComposeSecrets } from '../src/compose/mask.js'

describe('maskComposeSecrets', () => {
  const compose = `# commentaire conservé
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: example # en dur
      POSTGRES_USER: app
      POSTGRES_DB: \${DB_NAME}
  api:
    build:
      context: .
      args:
        NPM_TOKEN: npm_abc
    environment:
      - JWT_SECRET=abc
      - DATABASE_PASSWORD=\${DB_PASSWORD}
      - CACHE=redis://:motdepasse@cache:6379
      - MA_VARIABLE=valeur-secrete
      - PORT=3000
`

  it('masque les secrets en dur, garde les références et la mise en forme', () => {
    const { content, masked } = maskComposeSecrets(compose, ['MA_VARIABLE'])
    for (const value of ['example', 'npm_abc', 'JWT_SECRET=abc', 'motdepasse', 'valeur-secrete']) {
      expect(content).not.toContain(value)
    }
    expect(content).toContain('# commentaire conservé')
    expect(content).toContain(`POSTGRES_PASSWORD: ${MASK} # en dur`)
    expect(content).toContain('POSTGRES_DB: ${DB_NAME}')
    expect(content).toContain('DATABASE_PASSWORD=${DB_PASSWORD}')
    expect(content).toContain('POSTGRES_USER: app')
    expect(content).toContain('PORT=3000')
    expect(masked.sort()).toEqual([
      'api.CACHE',
      'api.JWT_SECRET',
      'api.MA_VARIABLE',
      'api.NPM_TOKEN',
      'db.POSTGRES_PASSWORD',
    ])
  })

  it('laisse intact un fichier sans secret ou illisible', () => {
    const plain = 'services:\n  web:\n    image: nginx\n'
    expect(maskComposeSecrets(plain, [])).toEqual({ content: plain, masked: [] })
    expect(maskComposeSecrets('services: [', []).masked).toEqual([])
  })
})
