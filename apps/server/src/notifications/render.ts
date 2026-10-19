import { createHmac } from 'node:crypto'
import type { NotificationSeverity } from '@vercio/shared'
import { VERCIO_VERSION } from '../version.js'
import { clean, type NotificationDigest, type NotificationMessage } from './message.js'

/** Taille maximale d'une carte Teams (la limite de Teams est d'environ 28 Ko). */
export const TEAMS_MAX_BYTES = 20 * 1024
const DIGEST_MAX_ITEMS = 15

export type Content =
  { kind: 'single'; message: NotificationMessage } | ({ kind: 'digest' } & NotificationDigest)

// --- Email -----------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const EMAIL_COLORS: Record<NotificationSeverity, string> = {
  critical: '#dc2626',
  warning: '#d97706',
  success: '#16a34a',
  info: '#2563eb',
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

/** Objet filtrable en boîte de réception : « [Vercio] Échec du déploiement · boutique / prod ». */
function subject(title: string): string {
  return `[Vercio] ${clean(title, 180)}`
}

export function renderEmail(content: Content): RenderedEmail {
  if (content.kind === 'digest') {
    const shown = content.items.slice(0, DIGEST_MAX_ITEMS)
    const more = content.items.length - shown.length
    const text = [
      content.title,
      '',
      ...shown.map((item) => `- ${item.title} : ${item.summary}`),
      ...(more > 0 ? [`… et ${more} autre(s)`] : []),
      '',
      ...(content.url ? [content.url] : []),
    ].join('\n')
    const html = layout(
      content.severity,
      content.title,
      `<ul style="padding-left:18px;margin:0">${shown
        .map(
          (item) =>
            `<li style="margin:0 0 6px"><strong>${escapeHtml(item.title)}</strong><br><span style="color:#525252">${escapeHtml(item.summary)}</span></li>`,
        )
        .join('')}</ul>${more > 0 ? `<p style="color:#525252">… et ${more} autre(s)</p>` : ''}`,
      content.url,
      'Ouvrir Vercio',
    )
    return { subject: subject(content.title), text, html }
  }

  const { message } = content
  const text = [
    message.title,
    '',
    message.summary,
    '',
    ...message.facts.map((fact) => `${fact.label} : ${fact.value}`),
    ...(message.details ? ['', message.details] : []),
    ...(message.url ? ['', `${message.linkLabel ?? 'Ouvrir dans Vercio'} : ${message.url}`] : []),
  ].join('\n')
  const facts = message.facts.length
    ? `<table style="border-collapse:collapse;margin:12px 0;font-size:14px">${message.facts
        .map(
          (fact) =>
            `<tr><td style="padding:2px 12px 2px 0;color:#737373;white-space:nowrap;vertical-align:top">${escapeHtml(fact.label)}</td><td style="padding:2px 0">${escapeHtml(fact.value)}</td></tr>`,
        )
        .join('')}</table>`
    : ''
  const details = message.details
    ? `<pre style="white-space:pre-wrap;word-break:break-word;background:#f5f5f5;border-radius:6px;padding:10px;font-size:12px;margin:12px 0">${escapeHtml(message.details)}</pre>`
    : ''
  const html = layout(
    message.severity,
    message.title,
    `<p style="margin:0">${escapeHtml(message.summary)}</p>${facts}${details}`,
    message.url,
    message.linkLabel ?? 'Ouvrir dans Vercio',
  )
  return { subject: subject(message.title), text, html }
}

function layout(
  severity: NotificationSeverity,
  title: string,
  body: string,
  url: string | null,
  linkLabel: string,
): string {
  const button = url
    ? `<p style="margin:16px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:14px">${escapeHtml(linkLabel)}</a></p>`
    : ''
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#171717"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-top:4px solid ${EMAIL_COLORS[severity]};border-radius:8px;padding:20px"><h1 style="font-size:17px;margin:0 0 12px">${escapeHtml(title)}</h1>${body}${button}</div><p style="max-width:600px;margin:12px auto 0;color:#a3a3a3;font-size:12px">Notification automatique de Vercio : ne pas répondre.</p></body></html>`
}

// --- Microsoft Teams (Workflows) -------------------------------------------------------

const TEAMS_COLORS: Record<NotificationSeverity, string> = {
  critical: 'Attention',
  warning: 'Warning',
  success: 'Good',
  info: 'Default',
}

/**
 * Valeurs dynamiques toujours dans des TextRun : Teams n'y interprète pas le Markdown
 * (un nom de branche ne peut pas devenir un lien). Les TextBlock ne portent que nos libellés.
 */
function textRun(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text, ...extra }] }
}

function fact(label: string, value: string) {
  return {
    type: 'ColumnSet',
    spacing: 'Small',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        items: [{ type: 'TextBlock', text: label, isSubtle: true, wrap: false }],
      },
      { type: 'Column', width: 'stretch', items: [textRun(value)] },
    ],
  }
}

function card(body: unknown[], url: string | null, linkLabel: string) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          // Seule action fiable avec le connecteur Workflows.
          actions: url ? [{ type: 'Action.OpenUrl', title: linkLabel, url }] : [],
        },
      },
    ],
  }
}

export function renderTeams(content: Content): string {
  if (content.kind === 'digest') {
    const shown = content.items.slice(0, DIGEST_MAX_ITEMS)
    const more = content.items.length - shown.length
    const body = [
      textRun(content.title, {
        weight: 'Bolder',
        size: 'Medium',
        color: TEAMS_COLORS[content.severity],
      }),
      ...shown.map((item) => ({
        type: 'Container',
        spacing: 'Small',
        items: [
          textRun(item.title, { weight: 'Bolder' }),
          textRun(item.summary, { isSubtle: true }),
        ],
      })),
      ...(more > 0 ? [textRun(`… et ${more} autre(s)`, { isSubtle: true })] : []),
    ]
    return JSON.stringify(card(body, content.url, 'Ouvrir Vercio'))
  }

  const { message } = content
  const build = (details: string | null) =>
    JSON.stringify(
      card(
        [
          textRun(message.title, {
            weight: 'Bolder',
            size: 'Medium',
            color: TEAMS_COLORS[message.severity],
          }),
          textRun(message.summary),
          ...message.facts.map((item) => fact(item.label, item.value)),
          ...(details
            ? [
                {
                  type: 'Container',
                  style: 'emphasis',
                  spacing: 'Medium',
                  items: [textRun(details, { fontType: 'Monospace', size: 'Small' })],
                },
              ]
            : []),
        ],
        message.url,
        message.linkLabel ?? 'Ouvrir dans Vercio',
      ),
    )
  let json = build(message.details)
  // Carte trop lourde (rare : l'erreur est déjà limitée) : le détail est raccourci.
  if (Buffer.byteLength(json) > TEAMS_MAX_BYTES && message.details) {
    json = build(clean(message.details, 300, { multiline: true }))
  }
  return json
}

// --- Webhook sortant -------------------------------------------------------------------

export const WEBHOOK_SCHEMA_VERSION = 1

/** Corps JSON du webhook sortant (un évènement par appel, jamais de récapitulatif). */
export function renderWebhookBody(deliveryId: string, message: NotificationMessage): string {
  return JSON.stringify({
    id: deliveryId,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    event: message.event,
    severity: message.severity,
    occurredAt: message.occurredAt,
    title: message.title,
    message: message.summary,
    url: message.url,
    project: message.project,
    environment: message.environment,
    incident: message.incident,
    facts: message.facts,
    details: message.details,
    data: message.data,
  })
}

/**
 * Secret au format Standard Webhooks (`whsec_` + clé en base64) : les bibliothèques de
 * vérification existantes (standardwebhooks, svix) l'acceptent tel quel.
 */
export function webhookSigningKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
}

/**
 * En-têtes Standard Webhooks : identifiant stable d'une tentative à l'autre (dédoublonnage),
 * horodatage recalculé à chaque tentative, signature HMAC-SHA256 de `id.timestamp.corps`.
 */
export function webhookHeaders(
  deliveryId: string,
  event: string,
  body: string,
  secret: string,
  now = Date.now(),
): Record<string, string> {
  const timestamp = Math.floor(now / 1000).toString()
  const signature = createHmac('sha256', webhookSigningKey(secret))
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest('base64')
  return {
    'content-type': 'application/json',
    'user-agent': `Vercio/${VERCIO_VERSION}`,
    'webhook-id': deliveryId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
    'x-vercio-event': event,
  }
}
