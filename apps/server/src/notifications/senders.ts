import nodemailer from 'nodemailer'
import type { SmtpSecurity } from '@vercio/shared'
import { defaultCertificates, describeNetworkError, httpRequest } from '../lib/http.js'
import {
  assertOutboundUrl,
  OutboundUrlError,
  redactUrls,
  type OutboundOptions,
  outboundDispatcher,
} from './outbound.js'
import type { RenderedEmail } from './render.js'

export interface SendResult {
  ok: boolean
  /** Erreur de configuration (identifiants, URL, adresse refusée) : inutile de réessayer. */
  permanent: boolean
  message: string
  /** Code de réponse SMTP ou statut HTTP. */
  statusCode: number | null
  retryAfterMs?: number
  warnings: string[]
  /** Réponse brute du serveur (500 caractères au plus), pour le détail d'un test. */
  response?: string
}

const ok = (message: string, statusCode: number | null, warnings: string[] = []): SendResult => ({
  ok: true,
  permanent: false,
  message,
  statusCode,
  warnings,
})

const failure = (
  message: string,
  permanent: boolean,
  statusCode: number | null = null,
  extra: Partial<SendResult> = {},
): SendResult => ({ ok: false, permanent, message, statusCode, warnings: [], ...extra })

// --- HTTP (Teams, webhook sortant) -----------------------------------------------------

/** Lit au plus `limit` octets de la réponse, puis libère la connexion. */
async function readLimited(response: Response, limit = 2048): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit)
}

/** Délai demandé par le serveur (`Retry-After` en secondes ou en date HTTP). */
function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

export async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: OutboundOptions & { kind: 'teams' | 'webhook' },
): Promise<SendResult> {
  try {
    await assertOutboundUrl(url, options)
  } catch (error) {
    if (error instanceof OutboundUrlError) return failure(error.message, error.permanent)
    throw error
  }
  let response: Response
  try {
    response = (await httpRequest(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      },
      { dispatcher: outboundDispatcher(options.allowLoopback) },
    )) as unknown as Response
  } catch (error) {
    return failure(redactUrls(describeNetworkError(error)), false)
  }
  const text = redactUrls(await readLimited(response))
  const status = response.status
  if (status >= 200 && status < 300) {
    // Teams répond 202 dès que le workflow accepte la requête : la carte est publiée ensuite.
    return ok(
      options.kind === 'teams' ? `Accepté par Teams (HTTP ${status})` : `Reçu (HTTP ${status})`,
      status,
    )
  }
  const extra = { response: text.slice(0, 500) }
  if (status >= 300 && status < 400) {
    return failure(
      `Redirection refusée (HTTP ${status}) : indiquez l’URL finale du récepteur`,
      true,
      status,
      extra,
    )
  }
  if (status === 408 || status === 429 || status >= 500) {
    return failure(
      status === 429
        ? `Trop de messages : le récepteur limite le débit (HTTP 429)`
        : `Le récepteur est indisponible (HTTP ${status})`,
      false,
      status,
      { ...extra, retryAfterMs: retryAfter(response.headers.get('retry-after')) },
    )
  }
  if (options.kind === 'teams' && (status === 401 || status === 403 || status === 404)) {
    return failure(
      `Workflow Teams introuvable ou désactivé (HTTP ${status}) : vérifiez le flux et collez sa nouvelle URL`,
      true,
      status,
      extra,
    )
  }
  return failure(`Le récepteur a refusé le message (HTTP ${status})`, true, status, extra)
}

// --- Email (SMTP) ----------------------------------------------------------------------

export interface SmtpConfig {
  host: string
  port: number
  security: SmtpSecurity
  username: string | null
  password: string | null
  from: string
  fromName: string
  caCertificate: string | null
}

function transport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    // STARTTLS obligatoire : un serveur qui ne le propose pas (ou un attaquant qui retire
    // l'annonce) fait échouer l'envoi au lieu d'envoyer le mot de passe en clair.
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
    tls: {
      minVersion: 'TLSv1.2',
      ...(config.caCertificate ? { ca: [...defaultCertificates(), config.caCertificate] } : {}),
    },
    // Délais courts : nodemailer attend sinon jusqu'à 10 min.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 5_000,
  })
}

interface SmtpErrorLike {
  code?: string
  responseCode?: number
  response?: string
  message?: string
  command?: string
}

/** Traduit une erreur SMTP en message actionnable et indique si un réessai a un sens. */
export function explainSmtpError(
  error: unknown,
  config: Pick<SmtpConfig, 'port' | 'security' | 'from'>,
): SendResult {
  const err = (error ?? {}) as SmtpErrorLike
  const code = err.code
  const responseCode = typeof err.responseCode === 'number' ? err.responseCode : null
  const response = (err.response ?? err.message ?? '').slice(0, 500)
  const extra = { response }

  if (code === 'EAUTH' || responseCode === 535) {
    let message = 'Identifiant ou mot de passe refusé par le serveur SMTP'
    if (/5\.7\.139|5\.7\.3\b|basic auth/i.test(response)) {
      message +=
        ' : l’authentification SMTP par mot de passe est désactivée sur ce compte (Microsoft 365 : activer « SMTP AUTH » ou utiliser un relais)'
    }
    return failure(message, true, responseCode, extra)
  }
  if (/5\.7\.60|SendAsDenied/i.test(response)) {
    return failure(
      `Le compte n’a pas le droit d’envoyer en tant que ${config.from}`,
      true,
      responseCode,
      extra,
    )
  }
  if (code === 'ETLS' || /STARTTLS/i.test(err.message ?? '')) {
    return failure(
      'Le serveur ne propose pas STARTTLS : choisissez « TLS implicite » (port 465) ou vérifiez le port',
      true,
      responseCode,
      extra,
    )
  }
  if (code === 'EENVELOPE') {
    return failure(`Adresse refusée par le serveur : ${response}`, true, responseCode, extra)
  }
  if (code === 'ETIMEDOUT' && err.command === 'CONN') {
    return failure('Serveur SMTP injoignable : délai de connexion dépassé', false, null, extra)
  }
  if (code === 'ETIMEDOUT' || /Greeting never received/i.test(err.message ?? '')) {
    return failure(
      config.security === 'tls'
        ? 'Pas de réponse du serveur : ce port attend peut-être STARTTLS (587) plutôt que TLS implicite'
        : config.port === 465
          ? 'Pas de réponse du serveur : le port 465 demande « TLS implicite »'
          : 'Le serveur SMTP ne répond pas (délai dépassé)',
      false,
      null,
      extra,
    )
  }
  if (code === 'EDNS') return failure('Serveur SMTP introuvable (DNS)', false, null, extra)
  if (code === 'ECONNECTION' || code === 'ESOCKET') {
    const network = describeNetworkError({ cause: error })
    const tls = /certificat|TLS/i.test(network)
    return failure(`Connexion au serveur SMTP impossible : ${network}`, tls, null, extra)
  }
  if (responseCode && responseCode >= 500) {
    return failure(
      `Message refusé par le serveur SMTP (${responseCode})`,
      true,
      responseCode,
      extra,
    )
  }
  if (responseCode && responseCode >= 400) {
    return failure(
      `Serveur SMTP temporairement indisponible (${responseCode})`,
      false,
      responseCode,
      extra,
    )
  }
  return failure(
    `Envoi impossible : ${err.message ?? 'erreur inconnue'}`,
    false,
    responseCode,
    extra,
  )
}

/** Vérifie la connexion et l'authentification, sans envoyer de message. */
export async function verifySmtp(config: SmtpConfig): Promise<SendResult> {
  const transporter = transport(config)
  try {
    await transporter.verify()
    return ok(
      config.username
        ? `Connexion et authentification réussies (${config.host}:${config.port})`
        : `Connexion réussie (${config.host}:${config.port}, sans authentification)`,
      null,
    )
  } catch (error) {
    return explainSmtpError(error, config)
  } finally {
    transporter.close()
  }
}

export async function sendMail(
  config: SmtpConfig,
  recipients: string[],
  email: RenderedEmail,
): Promise<SendResult> {
  if (recipients.length === 0) return failure('Aucun destinataire', true)
  const transporter = transport(config)
  try {
    const info = await transporter.sendMail({
      from: { name: config.fromName, address: config.from },
      // Une adresse par objet : aucune liste ni nom ne peut être injecté.
      to: recipients.map((address) => ({ name: '', address })),
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: {
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
      },
      disableFileAccess: true,
      disableUrlAccess: true,
    })
    const rejected = (info.rejected as (string | { address: string })[]).map((item) =>
      typeof item === 'string' ? item : item.address,
    )
    const code = Number(/^(\d{3})/.exec(info.response ?? '')?.[1]) || null
    if (rejected.length >= recipients.length) {
      return failure(`Toutes les adresses ont été refusées : ${rejected.join(', ')}`, true, code)
    }
    return ok(
      `Envoyé à ${recipients.length - rejected.length} destinataire(s)`,
      code,
      rejected.length ? [`Adresses refusées par le serveur : ${rejected.join(', ')}`] : [],
    )
  } catch (error) {
    return explainSmtpError(error, config)
  } finally {
    transporter.close()
  }
}
