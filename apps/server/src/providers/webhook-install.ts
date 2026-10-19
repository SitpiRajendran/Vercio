/** Webhook de dépôt créé par Vercio chez le fournisseur Git. */
export interface WebhookSpec {
  url: string
  secret: string
  existingId?: string | null
}

/** Création de webhook refusée ou impossible : message prêt à afficher. */
export class WebhookInstallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
