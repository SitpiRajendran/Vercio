import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml'
import type { AddComposeServiceInput } from '@vercio/shared'
import { COMPOSE_YAML } from './yaml.js'

export class ComposeEditError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

function load(content: string): Document {
  const document = parseDocument(content, COMPOSE_YAML)
  if (document.errors.length) {
    throw new ComposeEditError(`Fichier Compose illisible : ${document.errors[0]!.message}`)
  }
  if (!isMap(document.get('services'))) {
    throw new ComposeEditError('Le fichier Compose doit contenir une section services')
  }
  return document
}

/**
 * Projet « service seul » qui passe en Compose : jusque-là, Vercio transmettait toutes les
 * variables du projet à tous ses services. Pour que le service existant les reçoive encore (et
 * qu'elles n'aillent pas au nouveau), elles lui sont attribuées nommément (`environment: [CLÉ]`).
 */
export function pinVariables(document: Document, keys: string[]): void {
  if (!keys.length) return
  const services = document.get('services') as YAMLMap
  for (const pair of services.items) {
    const service = pair.value
    if (!isMap(service)) continue
    const environment = service.get('environment', true)
    if (isMap(environment)) {
      for (const key of keys) if (!environment.has(key)) environment.set(key, `\${${key}}`)
    } else if (isSeq(environment)) {
      const present = new Set(
        environment.items.map(
          (item) => String((item as { value?: unknown }).value ?? item).split('=')[0],
        ),
      )
      for (const key of keys) if (!present.has(key)) environment.add(key)
    } else {
      service.set('environment', document.createNode([...keys]))
    }
  }
}

/** Ajoute un service ; commentaires et mise en forme du reste du fichier conservés. */
export function addService(
  content: string,
  input: Required<Omit<AddComposeServiceInput, 'environment'>> & {
    environment: { key: string; value: string; secret: boolean }[]
  },
  pin: string[] | null,
): string {
  const document = load(content)
  const services = document.get('services') as YAMLMap
  if (services.has(input.name)) {
    throw new ComposeEditError(`Un service « ${input.name} » existe déjà`, 'name')
  }
  if (pin) pinVariables(document, pin)

  const service: Record<string, unknown> = { image: input.image, restart: 'unless-stopped' }
  if (input.port) service.expose = [String(input.port)]
  if (input.environment.length) {
    service.environment = Object.fromEntries(
      input.environment.map((item) => [item.key, item.secret ? `\${${item.key}}` : item.value]),
    )
  }
  if (input.dataPath) {
    const volume = `${input.name}-data`
    service.volumes = [`${volume}:${input.dataPath}`]
    const volumes = document.get('volumes')
    if (isMap(volumes)) {
      if (!volumes.has(volume)) volumes.set(volume, document.createNode({}))
    } else {
      document.set('volumes', document.createNode({ [volume]: {} }))
    }
  }
  services.set(input.name, document.createNode(service))
  return document.toString({ lineWidth: 0 })
}

/** Nombre de services d'un fichier (après une modification à la main). */
export function serviceCount(content: string): number {
  return (load(content).get('services') as YAMLMap).items.length
}

/** Variables attribuées nommément au besoin (passage de « service seul » à Compose). */
export function pinInContent(content: string, keys: string[]): string {
  const document = load(content)
  pinVariables(document, keys)
  return document.toString({ lineWidth: 0 })
}
