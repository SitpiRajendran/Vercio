import { useQuery } from '@tanstack/react-query'
import type { ProjectView } from '@vercio/shared'
import { api } from '@/lib/api'

/** Fichier Compose actuel du projet (lu dans le dépôt, sur la branche par défaut, si besoin). */
export function useProjectCompose(project: ProjectView) {
  const composeSource =
    project.compose.source === 'git'
      ? project.sources.find(
          (source) => source.id === (project.compose as { appSourceId: string }).appSourceId,
        )
      : undefined
  return useQuery({
    queryKey: ['projects', project.slug, 'compose', project.updatedAt],
    queryFn: async () => {
      if (project.compose.source === 'inline') {
        const content = project.compose.content
        return { content, analysis: await api.catalog.analyze(content) }
      }
      return api.catalog.composeFromGit(composeSource!.gitProviderId, {
        repository: composeSource!.repository,
        ref: composeSource!.defaultBranch,
        path: project.compose.path,
      })
    },
  })
}
