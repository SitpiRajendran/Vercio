import { z } from 'zod'

/** Noms de projets et d'environnements : utilisés dans les noms Docker, donc restreints. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const slugSchema = z.string().min(1).max(40).regex(SLUG_PATTERN, {
  message: 'Lettres minuscules, chiffres et tirets uniquement',
})

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/** Nom du projet Compose côté Docker : `vercio_<projet>_<environnement>`. */
export function composeProjectName(projectSlug: string, environmentSlug: string): string {
  return `vercio_${projectSlug}_${environmentSlug}`
}

/** Version au format `vX.Y` ou `vX.Y.Z`. */
export const VERSION_TAG_PATTERN = /^v\d+\.\d+(?:\.\d+)?$/

export function isVersionTag(tag: string): boolean {
  return VERSION_TAG_PATTERN.test(tag)
}

/** Nom du tag mobile d'une branche : `latest` pour la branche par défaut, `<branche>-latest` sinon. */
export function latestTagForBranch(branch: string, defaultBranch: string): string {
  if (branch === defaultBranch) return 'latest'
  return `${branch.replace(/[^A-Za-z0-9_.-]+/g, '-')}-latest`
}

/** Nom de branche utilisable dans un tag d'image (`feature/x` → `feature-x`). */
export function branchTagPart(branch: string): string {
  return branch.replace(/[^A-Za-z0-9_.-]+/g, '-')
}

/** Convention de tags d'images d'un dépôt (voir `TagConvention` dans projects.ts). */
export interface ChannelTagSettings {
  defaultBranch: string
  /** Ancien réglage : tag du dernier build de la branche par défaut (`latest`). */
  latestTagName: string
  /** Modèle du tag du dernier build, avec `{branch}` ; null : convention de Vercio. */
  latestTagTemplate: string | null
}

/**
 * Tag du dernier build d'une branche (canal suivi par « latest ») : le modèle du dépôt
 * (`{branch}` → `prod`), sinon `latest` sur la branche par défaut et `<branche>-latest` ailleurs.
 */
export function channelTag(branch: string, settings: ChannelTagSettings): string {
  if (settings.latestTagTemplate) {
    return settings.latestTagTemplate.replaceAll('{branch}', branchTagPart(branch))
  }
  return branch === settings.defaultBranch
    ? settings.latestTagName
    : latestTagForBranch(branch, settings.defaultBranch)
}

/** Tag de l'image d'un commit : `{sha}` (complet) ou `{sha:8}` (8 premiers caractères). */
export function commitImageTag(template: string, sha: string): string {
  return template
    .replace(/\{sha:(\d{1,2})\}/g, (_match, length: string) => sha.slice(0, Number(length)))
    .replaceAll('{sha}', sha)
}
