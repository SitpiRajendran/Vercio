/** Noms qui ressemblent à un secret : la variable est importée comme secrète (masquée). */
const SECRET_NAME = /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL/i

export function looksSecret(key: string): boolean {
  return SECRET_NAME.test(key)
}

export interface DotenvEntry {
  key: string
  value: string
  secret: boolean
}

/**
 * Lecture d'un fichier `.env` au format de Docker Compose : `CLÉ=valeur`, `export` facultatif,
 * commentaires, valeurs entre guillemets simples (littérales) ou doubles (`\n`, `\"`, `\\`).
 * Les références `${…}` sont gardées telles quelles.
 */
export function parseDotenv(content: string): DotenvEntry[] {
  const entries = new Map<string, DotenvEntry>()
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let raw = match[2]!
    let value: string
    const quote = raw[0]
    if (quote === '"' || quote === "'") {
      // Valeur entre guillemets, éventuellement sur plusieurs lignes.
      let body = raw.slice(1)
      while (!closes(body, quote) && index + 1 < lines.length) {
        index++
        body += `\n${lines[index]}`
      }
      const end = closingIndex(body, quote)
      raw = end === -1 ? body : body.slice(0, end)
      value =
        quote === "'"
          ? raw
          : raw.replace(/\\([\\"nrt$])/g, (_all, char: string) =>
              char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char,
            )
    } else {
      // Commentaire en fin de ligne : précédé d'une espace.
      value = raw.replace(/\s+#.*$/, '').trim()
    }
    entries.set(key, { key, value, secret: SECRET_NAME.test(key) })
  }
  return [...entries.values()]
}

function closingIndex(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === '\\') {
      i++
      continue
    }
    if (body[i] === quote) return i
  }
  return -1
}

function closes(body: string, quote: string): boolean {
  return closingIndex(body, quote) !== -1
}
