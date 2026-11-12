import { isMap, isPair, isScalar, isSeq, parseDocument, type Document } from 'yaml'
import { COMPOSE_YAML } from './yaml.js'

/** Valeur affichée à la place d'un secret. */
export const MASK = '••••••'

/** Noms qui désignent presque toujours un secret. */
const SECRET_NAME =
  /(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|AUTH|_KEY$|^KEY$|DSN|DATABASE_URL|_URI$)/i

/** `${VAR}`, `$VAR` ou `${VAR:-défaut}` seul : une référence, pas une valeur. */
const REFERENCE_ONLY = /^\$\{?[A-Za-z_][A-Za-z0-9_]*(?:[:?-][^}]*)?\}?$/

export interface MaskResult {
  content: string
  /** Variables masquées (`service.CLÉ`). */
  masked: string[]
}

/** Adresse avec identifiants : `postgres://utilisateur:motdepasse@hôte` (utilisateur facultatif). */
const URL_WITH_PASSWORD = /:\/\/[^\s/:@]*:[^\s/@]+@/

function shouldMask(key: string, value: string, secrets: Set<string>): boolean {
  if (!value || REFERENCE_ONLY.test(value.trim())) return false
  return secrets.has(key) || SECRET_NAME.test(key) || URL_WITH_PASSWORD.test(value)
}

/**
 * Masque les valeurs secrètes d'un fichier Compose sans toucher au reste (commentaires et mise
 * en forme conservés) : `environment` et `build.args` de chaque service, quand la clé est une
 * variable secrète de Vercio ou que son nom ressemble à un secret. Les références `${VAR}` restent
 * lisibles : elles ne contiennent aucune valeur.
 */
export function maskComposeSecrets(content: string, secretKeys: Iterable<string>): MaskResult {
  const secrets = new Set(secretKeys)
  const masked: string[] = []
  let document: Document
  try {
    document = parseDocument(content, COMPOSE_YAML)
  } catch {
    return { content, masked }
  }
  if (document.errors.length) return { content, masked }
  const services = document.get('services')
  if (!isMap(services)) return { content, masked }

  for (const pair of services.items) {
    const serviceName = isScalar(pair.key) ? String(pair.key.value) : '?'
    const service = pair.value
    if (!isMap(service)) continue
    const blocks = [service.get('environment', true)]
    const build = service.get('build', true)
    if (isMap(build)) blocks.push(build.get('args', true))
    for (const block of blocks) {
      if (isMap(block)) {
        // CLÉ: valeur
        for (const item of block.items) {
          if (!isPair(item) || !isScalar(item.key) || !isScalar(item.value)) continue
          const key = String(item.key.value)
          const value = item.value.value == null ? '' : String(item.value.value)
          if (shouldMask(key, value, secrets)) {
            item.value.value = MASK
            masked.push(`${serviceName}.${key}`)
          }
        }
      } else if (isSeq(block)) {
        // - CLÉ=valeur
        for (const item of block.items) {
          if (!isScalar(item) || typeof item.value !== 'string') continue
          const index = item.value.indexOf('=')
          if (index < 0) continue
          const key = item.value.slice(0, index)
          if (shouldMask(key, item.value.slice(index + 1), secrets)) {
            item.value = `${key}=${MASK}`
            masked.push(`${serviceName}.${key}`)
          }
        }
      }
    }
  }
  return { content: masked.length ? document.toString({ lineWidth: 0 }) : content, masked }
}
