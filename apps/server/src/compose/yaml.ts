/**
 * Lecture des fichiers Compose comme Docker Compose : clés de fusion YAML (`<<: *commun`)
 * résolues, alias limités (pas de « billion laughs »).
 */
export const COMPOSE_YAML = { merge: true, maxAliasCount: 100 } as const
