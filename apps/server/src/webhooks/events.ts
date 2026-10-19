import type { WebhookKind } from '@vercio/shared'

/** Ce qu'un appel de webhook annonce, une fois traduit depuis le format du fournisseur. */
export interface WebhookEvent {
  /** Test de connexion envoyé par le fournisseur (GitHub `ping`). */
  ping: boolean
  /** L'appel peut annoncer de nouvelles images : le registry doit être relu. */
  relevant: boolean
  /** Motif quand l'appel est sans effet. */
  reason: string | null
  /** Branche ou tag à l'origine du build (null : inconnu, ex. publication d'un paquet). */
  ref: string | null
  /** `ref` est un tag et non une branche (null : à déduire du format du nom). */
  isTag: boolean | null
  /** Résumé conservé dans l'historique des appels (le corps complet n'est pas stocké). */
  details: Record<string, string | null>
}

export class WebhookPayloadError extends Error {}

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Corps JSON (ou formulaire GitHub `payload=…`) ; un corps vide vaut `{}`. */
export function parseBody(raw: Buffer | undefined, contentType: string | undefined): Json {
  const content = raw?.toString('utf8').trim() ?? ''
  if (!content) return {}
  try {
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      const payload = new URLSearchParams(content).get('payload')
      return object(JSON.parse(payload ?? '{}'))
    }
    return object(JSON.parse(content))
  } catch {
    throw new WebhookPayloadError('Corps de la requête invalide : JSON attendu')
  }
}

const event = (values: Partial<WebhookEvent> & Pick<WebhookEvent, 'details'>): WebhookEvent => ({
  ping: false,
  relevant: false,
  reason: null,
  ref: null,
  isTag: null,
  ...values,
})

/** Webhook générique, appelé en fin de pipeline : `{ "branch": "main", "tag": "v1.2" }` (facultatif). */
export function genericEvent(body: Json): WebhookEvent {
  const branch = text(body.branch)
  const tag = text(body.tag)
  return event({
    relevant: true,
    ref: branch ?? tag,
    isTag: branch ? false : tag ? true : null,
    details: { branch, tag },
  })
}

/** Webhook de projet GitLab : évènements Pipeline (réussis) et Tag push. */
export function gitlabEvent(header: string | undefined, body: Json): WebhookEvent {
  const kind = text(body.object_kind)
  if (kind === 'pipeline') {
    const attributes = object(body.object_attributes)
    const ref = text(attributes.ref)
    const status = text(attributes.status)
    const details = {
      event: 'pipeline',
      ref,
      status,
      pipeline: attributes.id === undefined ? null : String(attributes.id),
    }
    const isTag = attributes.tag === true
    if (status !== 'success') {
      return event({
        ref,
        isTag,
        details,
        reason: `Pipeline ${status ?? 'inconnu'} : en attente de sa réussite`,
      })
    }
    return event({ relevant: true, ref, isTag, details })
  }
  if (kind === 'tag_push') {
    const ref = text(body.ref)?.replace(/^refs\/tags\//, '') ?? null
    return event({
      ref,
      isTag: true,
      details: { event: 'tag push', ref },
      reason: 'Nouveau tag : la liste des versions sera relue ; déploiement à la fin du pipeline',
    })
  }
  return event({
    details: { event: header ?? kind ?? 'inconnu' },
    reason: `Évènement non pris en charge (${header ?? kind ?? 'inconnu'}) : cochez « Pipeline events »`,
  })
}

/** Webhook de dépôt GitHub : `workflow_run` terminé avec succès, publication de paquet (GHCR). */
export function githubEvent(header: string | undefined, body: Json): WebhookEvent {
  const action = text(body.action)
  if (header === 'ping') {
    return event({ ping: true, details: { event: 'ping' }, reason: 'Test de connexion GitHub' })
  }
  if (header === 'workflow_run') {
    const run = object(body.workflow_run)
    const ref = text(run.head_branch)
    const conclusion = text(run.conclusion)
    const details = { event: 'workflow_run', workflow: text(run.name), ref, action, conclusion }
    if (action !== 'completed') {
      return event({ ref, details, reason: 'Workflow en cours : en attente de sa fin' })
    }
    if (conclusion !== 'success') {
      return event({
        ref,
        details,
        reason: `Workflow terminé sans succès (${conclusion ?? 'inconnu'})`,
      })
    }
    return event({ relevant: true, ref, details })
  }
  if (header === 'package' || header === 'registry_package') {
    const pkg = object(body.package ?? body.registry_package)
    const version = object(pkg.package_version)
    const details = {
      event: header,
      package: text(pkg.name),
      version: text(version.name) ?? text(version.version),
      action,
    }
    if (action !== 'published') {
      return event({ details, reason: `Action de paquet ignorée (${action ?? 'inconnue'})` })
    }
    return event({ relevant: true, details })
  }
  return event({
    details: { event: header ?? 'inconnu' },
    reason: `Évènement non pris en charge (${header ?? 'inconnu'}) : choisissez « Workflow runs »`,
  })
}

export function parseEvent(
  kind: WebhookKind,
  headers: Record<string, string | string[] | undefined>,
  body: Json,
): WebhookEvent {
  const header = (name: string) => {
    const value = headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  if (kind === 'gitlab') return gitlabEvent(header('x-gitlab-event'), body)
  if (kind === 'github') return githubEvent(header('x-github-event'), body)
  return genericEvent(body)
}
