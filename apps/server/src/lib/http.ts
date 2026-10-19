import tls from 'node:tls'
import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher, type Response } from 'undici'

export interface HttpOptions {
  /** Autorité de certification interne (PEM), ajoutée aux autorités par défaut. */
  caCertificate?: string | null
  timeoutMs?: number
  /** Agent imposé (ex. résolution DNS contrôlée des notifications sortantes). */
  dispatcher?: Dispatcher
}

const dispatchers = new Map<string, Dispatcher>()

/** Autorités par défaut, y compris celles de NODE_EXTRA_CA_CERTS. */
export function defaultCertificates(): string[] {
  const withExtra = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates
  return withExtra ? withExtra('default') : [...tls.rootCertificates]
}

/**
 * Agent HTTP par autorité de certification. Respecte HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 * (proxy d'entreprise) et ajoute l'éventuelle autorité interne aux autorités par défaut.
 */
function dispatcherFor(caCertificate?: string | null): Dispatcher {
  const key = caCertificate ?? ''
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    const ca = caCertificate ? [...defaultCertificates(), caCertificate] : undefined
    const useProxy = Boolean(
      process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY,
    )
    dispatcher = useProxy
      ? new EnvHttpProxyAgent(ca ? { connect: { ca }, requestTls: { ca } } : {})
      : new Agent(ca ? { connect: { ca } } : {})
    dispatchers.set(key, dispatcher)
  }
  return dispatcher
}

export async function httpRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  options: HttpOptions = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'manual',
    dispatcher: options.dispatcher ?? dispatcherFor(options.caCertificate),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
}

const TLS_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
])

/** Traduit une erreur réseau en message compréhensible. */
export function describeNetworkError(error: unknown): string {
  type ErrorLike = { code?: string | number; message?: string; cause?: ErrorLike }
  const cause = (error as ErrorLike)?.cause
  const proxyMessage = cause?.cause?.message ?? ''
  const proxyStatus = /Proxy response \((\d+)\)/.exec(proxyMessage)?.[1]
  if (proxyStatus) {
    return proxyStatus === '407'
      ? 'Le proxy HTTP exige une authentification (HTTPS_PROXY)'
      : `Hôte injoignable via le proxy HTTP (réponse ${proxyStatus}) : vérifiez l’adresse`
  }
  const rawCode = cause?.code ?? (error as ErrorLike)?.code
  const code = typeof rawCode === 'string' ? rawCode : undefined
  const name = (error as { name?: string })?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'Délai de réponse dépassé (10 s)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Hôte introuvable (DNS)'
  if (code === 'ECONNREFUSED') return 'Connexion refusée : le service ne répond pas sur ce port'
  if (code === 'ECONNRESET') return 'Connexion interrompue par le serveur'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Hôte injoignable depuis Vercio'
  if (code && TLS_ERRORS.has(code)) {
    return 'Certificat TLS non reconnu : ajoutez le certificat de votre autorité interne'
  }
  if (code === 'CERT_HAS_EXPIRED') return 'Le certificat TLS du serveur a expiré'
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'Le certificat TLS ne correspond pas au nom de l’hôte'
  }
  if (code === 'EPROTO' || code?.startsWith('ERR_SSL_')) {
    return 'Erreur TLS : le serveur ne parle peut-être pas HTTPS sur ce port'
  }
  return cause?.message ?? (error instanceof Error ? error.message : 'Erreur réseau inconnue')
}
