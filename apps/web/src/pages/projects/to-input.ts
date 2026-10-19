import type { ProjectInput, ProjectView } from '@vercio/shared'

/** Reconstruit la saisie complète d'un projet à partir de sa vue (pour une modification partielle). */
export function projectToInput(
  project: ProjectView,
  overrides: Partial<ProjectInput> = {},
): ProjectInput {
  return {
    name: project.name,
    slug: project.slug,
    description: project.description ?? undefined,
    type: project.type,
    compose:
      project.compose.source === 'git'
        ? { source: 'git', sourceKey: project.compose.appSourceId, path: project.compose.path }
        : { source: 'inline', content: project.compose.content },
    sources: project.sources.map((source) => ({
      key: source.id,
      name: source.name,
      gitProviderId: source.gitProviderId,
      repository: source.repository,
      defaultBranch: source.defaultBranch,
      ...source.tagConvention,
    })),
    trackedServices: project.trackedServices.map((service) => ({
      serviceName: service.serviceName,
      sourceKey: service.appSourceId,
      registryId: service.registryId,
      imageRepository: service.imageRepository,
    })),
    ...overrides,
  }
}
