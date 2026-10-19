import type {
  BranchSummary,
  ConnectionCheck,
  GitProviderType,
  RegistryImageSuggestion,
  RepositorySummary,
} from '@vercio/shared'
import { GitHubApiError, GitHubClient } from './github.js'
import { GitLabApiError, GitLabClient } from './gitlab.js'
import type { WebhookSpec } from './webhook-install.js'

export { WebhookInstallError, type WebhookSpec } from './webhook-install.js'

/**
 * Accès à un fournisseur Git : lecture, et création du webhook du dépôt. Le reste de Vercio ne
 * connaît que cette interface.
 */
export interface GitProviderClient {
  check(): Promise<ConnectionCheck>
  /** Identifiant du compte du token (utilisé comme login pour le registry associé). */
  accountName(): Promise<string | null>
  searchRepositories(query: string): Promise<RepositorySummary[]>
  listBranches(repository: string): Promise<BranchSummary[]>
  getFile(repository: string, path: string, ref: string): Promise<string>
  /** Chemins de tous les fichiers du dépôt sur une branche (liste éventuellement tronquée). */
  listFiles(repository: string, ref: string): Promise<string[]>
  /** Images du registry intégré au fournisseur pour ce dépôt (suggestions). */
  registryImages(repository: string): Promise<RegistryImageSuggestion[]>
  /** Derniers commits d'une branche, du plus récent au plus ancien. */
  listCommits(repository: string, branch: string, limit: number): Promise<GitTag[]>
  /** Tags du dépôt, les plus récents en premier quand le fournisseur le permet. */
  listTags(repository: string): Promise<GitTag[]>
  /** Complète un tag dont le fournisseur ne donne pas le commit (GitHub). */
  commitDetails(repository: string, sha: string): Promise<Partial<GitTag>>
  isCommitOnBranch(repository: string, sha: string, branch: string): Promise<boolean>
  commitUrl(repository: string, sha: string): string
  pipelineUrl(repository: string, ref: string): string
  /**
   * Crée le webhook du dépôt vers Vercio, ou met à jour celui déjà créé (`existingId`).
   * Lève `WebhookInstallError` avec un message lisible si le token n'en a pas le droit.
   */
  installWebhook(repository: string, hook: WebhookSpec): Promise<{ id: string }>
  /** Supprime le webhook créé par Vercio ; sans erreur s'il n'existe plus. */
  removeWebhook(repository: string, id: string): Promise<void>
  /** Page des webhooks du dépôt chez le fournisseur. */
  webhooksPageUrl(repository: string): string
}

export interface GitTag {
  name: string
  sha: string
  message: string | null
  author: string | null
  date: string | null
}

export function gitProviderClient(settings: {
  type: GitProviderType
  url: string
  token: string
  caCertificate?: string | null
}): GitProviderClient {
  if (settings.type === 'github') {
    const client = new GitHubClient(settings)
    return {
      check: () => client.check(),
      accountName: () =>
        client
          .get<{ login: string }>('/user')
          .then((user) => user.login)
          .catch(() => null),
      searchRepositories: (query) => client.searchRepositories(query),
      listBranches: (repository) => client.listBranches(repository),
      getFile: (repository, path, ref) => client.getFile(repository, path, ref),
      listFiles: (repository, ref) => client.listFiles(repository, ref),
      registryImages: (repository) => client.registryImages(repository),
      listTags: (repository) => client.listTags(repository),
      listCommits: (repository, branch, limit) => client.listCommits(repository, branch, limit),
      commitDetails: (repository, sha) => client.commitDetails(repository, sha),
      isCommitOnBranch: (repository, sha, branch) =>
        client.isCommitOnBranch(repository, sha, branch),
      commitUrl: (repository, sha) => client.commitUrl(repository, sha),
      pipelineUrl: (repository, ref) => client.pipelineUrl(repository, ref),
      installWebhook: (repository, hook) => client.installWebhook(repository, hook),
      removeWebhook: (repository, id) => client.removeWebhook(repository, id),
      webhooksPageUrl: (repository) => `${settings.url}/${repository}/settings/hooks`,
    }
  }
  const client = new GitLabClient(settings)
  return {
    check: () => client.check(),
    accountName: () =>
      client
        .get<{ username: string }>('/user')
        .then((user) => user.username)
        .catch(() => null),
    searchRepositories: (query) => client.searchRepositories(query),
    listBranches: (repository) => client.listBranches(repository),
    getFile: (repository, path, ref) => client.getFile(repository, path, ref),
    listFiles: (repository, ref) => client.listFiles(repository, ref),
    registryImages: (repository) => client.registryImages(repository),
    listTags: (repository) => client.listTags(repository),
    listCommits: (repository, branch, limit) => client.listCommits(repository, branch, limit),
    commitDetails: async () => ({}),
    isCommitOnBranch: (repository, sha, branch) => client.isCommitOnBranch(repository, sha, branch),
    commitUrl: (repository, sha) => client.commitUrl(repository, sha),
    pipelineUrl: (repository, ref) => client.pipelineUrl(repository, ref),
    installWebhook: (repository, hook) => client.installWebhook(repository, hook),
    removeWebhook: (repository, id) => client.removeWebhook(repository, id),
    webhooksPageUrl: (repository) => `${settings.url}/${repository}/-/hooks`,
  }
}

/** Erreur d'API d'un fournisseur : message prêt à afficher et code HTTP d'origine. */
export function providerErrorStatus(error: unknown): number | null {
  if (error instanceof GitLabApiError || error instanceof GitHubApiError) return error.status
  return null
}
