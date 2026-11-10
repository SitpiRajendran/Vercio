/**
 * Décalage de l'horloge du serveur, mesuré avec l'en-tête `Date` d'une réponse HTTPS (GitHub,
 * à la vérification des mises à jour). Une horloge en avance ou en retard d'une minute fait
 * refuser tous les codes de double authentification : le décalage mesuré est compensé pour
 * eux, dans une limite raisonnable.
 */

/** En dessous : précision de l'en-tête (la seconde), rien à corriger. */
const MIN_CORRECTION_MS = 5_000
/** Au-delà : mesure douteuse, on ne s'y fie pas pour la sécurité. */
const MAX_CORRECTION_MS = 15 * 60_000

interface ClockMeasure {
  /** Heure de référence moins heure du serveur : négatif quand le serveur avance. */
  offsetMs: number
  measuredAt: string
  source: string
}

let measure: ClockMeasure | null = null

/**
 * Enregistre une mesure. `sentAt` et `receivedAt` encadrent la requête : la référence est
 * comparée au milieu de l'aller-retour. L'en-tête est tronqué à la seconde (+0,5 s en moyenne).
 */
export function recordReferenceTime(
  dateHeader: string | null,
  sentAt: number,
  receivedAt: number,
  source: string,
): ClockMeasure | null {
  if (!dateHeader) return null
  const reference = Date.parse(dateHeader)
  if (Number.isNaN(reference)) return null
  measure = {
    offsetMs: Math.round(reference + 500 - (sentAt + receivedAt) / 2),
    measuredAt: new Date(receivedAt).toISOString(),
    source,
  }
  return measure
}

/** Correction à ajouter à `Date.now()` pour les codes TOTP ; 0 sans mesure ou hors limites. */
export function totpClockCorrection(): number {
  if (!measure) return 0
  const size = Math.abs(measure.offsetMs)
  return size >= MIN_CORRECTION_MS && size <= MAX_CORRECTION_MS ? measure.offsetMs : 0
}

export function clockStatus() {
  if (!measure) return null
  return {
    offsetSeconds: Math.round(measure.offsetMs / 1000),
    measuredAt: measure.measuredAt,
    source: measure.source,
    corrected: totpClockCorrection() !== 0,
  }
}

/** Tests : oublie la mesure. */
export function resetClockMeasure(): void {
  measure = null
}
