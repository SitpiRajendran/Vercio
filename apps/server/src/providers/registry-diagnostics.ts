/**
 * Image absente : on regarde ce que contient le registry pour dire si c'est le chemin de l'image
 * qui est faux, ou le tag attendu qui n'a pas été poussé par la CI.
 */
export async function missingImageMessage(
  client: { listTags(path: string): Promise<string[] | null> },
  target: { service: string; registryName: string; image: string; path: string; tag: string },
): Promise<string> {
  const base = `Image ${target.service} introuvable : ${target.image}:${target.tag}`
  let tags: string[] | null
  try {
    tags = await client.listTags(target.path)
  } catch {
    return base
  }
  if (tags === null) {
    return `${base}. Aucune image à ce chemin dans le registry « ${target.registryName} » : vérifiez le « Chemin de l’image » de ce service (onglet Services).`
  }
  if (tags.length === 0) {
    return `${base}. Le dépôt d’images existe mais ne contient aucun tag : la CI n’a encore rien poussé.`
  }
  const shown = [...tags].sort().reverse().slice(0, 10)
  return `${base}. Le tag « ${target.tag} » n’existe pas ; tags présents : ${shown.join(', ')}${tags.length > shown.length ? '…' : ''}. La CI doit pousser l’image avec le tag ${target.tag}.`
}
