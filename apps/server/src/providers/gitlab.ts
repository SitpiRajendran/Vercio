import type { GitTag } from './git.js'
import type {
  BranchSummary,
  ConnectionCheck,
  RegistryImageSuggestion,
  RepositorySummary,
} from '@vercio/shared'
import { describeNetworkError, httpRequest, type HttpOptions } from '../lib/http.js'
import { CheckReport } from './check.js'
import { WebhookInstallError, type WebhookSpec } from './webhook-install.js'

export interface GitLabSettings extends HttpOptions {
  /** URL de l'instance, sans /api/v4 : https://gitlab.com */
  url: string
  token: string
}

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Client de l'API REST v4 de GitLab (GitLab.com et instances auto-hébergées, CE ou EE). */
export class GitLabClient {
  constructor(private readonly settings: GitLabSettings) {}

  get apiUrl(): string {
    return `${this.settings.url}/api/v4`
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.fetch(path)).json()) as T
  }

  async getText(path: string): Promise<string> {
    return (await this.fetch(path)).text()
  }

  /** Écriture (webhooks) : la réponse est rendue telle quelle, l'appelant interprète le code. */
  private send(method: string, path: string, body?: object) {
    return httpRequest(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          'PRIVATE-TOKEN': this.settings.token,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      this.settings,
    )
  }

  async installWebhook(repository: string, hook: WebhookSpec): Promise<{ id: string }> {
    const project = encodeURIComponent(repository)
    const body = {
      url: hook.url,
      token: hook.secret,
      // Le déploiement suit la fin des pipelines, pas les pushs eux-mêmes.
      pipeline_events: true,
      push_events: false,
      tag_push_events: false,
      enable_ssl_verification: hook.url.startsWith('https:'),
    }
    if (hook.existingId) {
      const updated = await this.send('PUT', `/projects/${project}/hooks/${hook.existingId}`, body)
      if (updated.ok) return { id: String(((await updated.json()) as { id: number }).id) }
      if (updated.status !== 404) throw gitLabHookError(updated.status)
    }
    const created = await this.send('POST', `/projects/${project}/hooks`, body)
    if (!created.ok) throw gitLabHookError(created.status)
    return { id: String(((await created.json()) as { id: number }).id) }
  }

  async removeWebhook(repository: string, id: string): Promise<void> {
    const response = await this.send(
      'DELETE',
      `/projects/${encodeURIComponent(repository)}/hooks/${id}`,
    )
    if (!response.ok && response.status !== 404) throw gitLabHookError(response.status)
  }

  private async fetch(path: string) {
    const response = await httpRequest(
      `${this.apiUrl}${path}`,
      { headers: { 'PRIVATE-TOKEN': this.settings.token, Accept: 'application/json' } },
      this.settings,
    )
    if (response.status >= 300 && response.status < 400) {
      throw new GitLabApiError(
        response.status,
        `Redirection inattendue vers ${response.headers.get('location') ?? '?'} : vérifiez l’URL (http/https, chemin)`,
      )
    }
    if (!response.ok) {
      throw new GitLabApiError(response.status, gitLabErrorMessage(response.status))
    }
    return response
  }

  async searchRepositories(query: string): Promise<RepositorySummary[]> {
    const params = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      order_by: 'last_activity_at',
      per_page: '20',
    })
    if (query) params.set('search', query)
    const projects = await this.get<
      {
        path_with_namespace: string
        name: string
        default_branch: string | null
        web_url: string
        visibility: string
      }[]
    >(`/projects?${params}`)
    return projects.map((project) => ({
      fullName: project.path_with_namespace,
      name: project.name,
      defaultBranch: project.default_branch,
      webUrl: project.web_url,
      private: project.visibility !== 'public',
    }))
  }

  async listBranches(repository: string): Promise<BranchSummary[]> {
    const branches = await this.get<{ name: string; default: boolean }[]>(
      `/projects/${encodeURIComponent(repository)}/repository/branches?per_page=100`,
    )
    return branches.map((branch) => ({ name: branch.name, isDefault: branch.default }))
  }

  async getFile(repository: string, path: string, ref: string): Promise<string> {
    try {
      return await this.getText(
        `/projects/${encodeURIComponent(repository)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      )
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) {
        throw new GitLabApiError(404, `Fichier ${path} introuvable sur la branche ${ref}`)
      }
      throw error
    }
  }

  /** Arborescence complète, par pages de 100 (au plus 2 000 entrées). */
  async listFiles(repository: string, ref: string): Promise<string[]> {
    const files: string[] = []
    for (let page = 1; page <= 20; page++) {
      const entries = await this.get<{ path: string; type: string }[]>(
        `/projects/${encodeURIComponent(repository)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
      )
      files.push(...entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path))
      if (entries.length < 100) break
    }
    return files
  }

  async listCommits(repository: string, branch: string, limit: number): Promise<GitTag[]> {
    const commits = await this.get<
      { id: string; title: string; author_name: string; committed_date: string }[]
    >(
      `/projects/${encodeURIComponent(repository)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`,
    )
    return commits.map((commit) => ({
      name: commit.id,
      sha: commit.id,
      message: commit.title,
      author: commit.author_name,
      date: commit.committed_date,
    }))
  }

  async listTags(repository: string): Promise<GitTag[]> {
    const tags = await this.get<
      {
        name: string
        commit: { id: string; title: string; author_name: string; created_at: string }
      }[]
    >(
      `/projects/${encodeURIComponent(repository)}/repository/tags?per_page=100&order_by=updated&sort=desc`,
    )
    return tags.map((tag) => ({
      name: tag.name,
      sha: tag.commit.id,
      message: tag.commit.title,
      author: tag.commit.author_name,
      date: tag.commit.created_at,
    }))
  }

  async isCommitOnBranch(repository: string, sha: string, branch: string): Promise<boolean> {
    const refs = await this.get<{ name: string }[]>(
      `/projects/${encodeURIComponent(repository)}/repository/commits/${sha}/refs?type=branch&per_page=100`,
    )
    return refs.some((ref) => ref.name === branch)
  }

  commitUrl(repository: string, sha: string): string {
    return `${this.settings.url}/${repository}/-/commit/${sha}`
  }

  pipelineUrl(repository: string, ref: string): string {
    return `${this.settings.url}/${repository}/-/pipelines?ref=${encodeURIComponent(ref)}`
  }

  async registryImages(repository: string): Promise<RegistryImageSuggestion[]> {
    const images = await this.get<{ location: string }[]>(
      `/projects/${encodeURIComponent(repository)}/registry/repositories?per_page=100`,
    ).catch(() => [])
    return images.flatMap((image) => {
      const slash = image.location.indexOf('/')
      return slash === -1
        ? []
        : [{ host: image.location.slice(0, slash), path: image.location.slice(slash + 1) }]
    })
  }

  async check(): Promise<ConnectionCheck> {
    const report = new CheckReport()
    try {
      const user = await this.get<{ username: string; name: string; bot?: boolean }>('/user')
      report.detail(
        'Compte',
        user.bot ? `${user.username} (token de projet ou de groupe)` : user.username,
      )

      const version = await this.get<{ version: string }>('/version').catch(() => null)
      report.detail('Version de GitLab', version?.version)

      const token = await this.get<{
        name: string
        scopes: string[]
        expires_at: string | null
      }>('/personal_access_tokens/self').catch(() => null)

      if (token) {
        report.detail('Token', token.name).detail('Portées', token.scopes.join(', '))
        report.detail('Expiration', token.expires_at ?? 'aucune')
        checkScopes(token.scopes, report)
        if (token.expires_at) {
          const days = Math.floor((Date.parse(token.expires_at) - Date.now()) / 86_400_000)
          if (days < 30) report.warn(`Le token expire dans ${Math.max(days, 0)} jour(s).`)
        }
      } else {
        report.warn('Impossible de lire les portées du token : vérifiez read_api et read_registry.')
      }
      return report.ok(`Connecté à GitLab en tant que ${user.username}`)
    } catch (error) {
      return report.fail(
        error instanceof GitLabApiError ? error.message : describeNetworkError(error),
      )
    }
  }
}

function checkScopes(scopes: string[], report: CheckReport) {
  const has = (scope: string) => scopes.includes(scope)
  if (!has('read_api') && !has('api')) {
    report.warn('Portée read_api manquante : Vercio ne pourra pas lire les branches et les tags.')
  }
  if (!has('read_registry')) {
    report.warn(
      'Portée read_registry absente : nécessaire pour utiliser ce token avec le registry GitLab.',
    )
  }
  if (has('api') || has('write_repository') || has('write_registry')) {
    report.warn(
      'Ce token a des droits d’écriture : Vercio n’a besoin que de read_api et read_registry.',
    )
  }
}

function gitLabHookError(status: number): WebhookInstallError {
  if (status === 401 || status === 403) {
    return new WebhookInstallError(
      'Le token ne peut pas créer de webhook : il faut la portée « api » (read_api ne suffit pas) et le rôle Maintainer sur le projet.',
      status,
    )
  }
  if (status === 404) {
    return new WebhookInstallError(
      'Projet introuvable sur GitLab, ou token sans accès à ce projet.',
      status,
    )
  }
  if (status === 422) {
    return new WebhookInstallError(
      'GitLab refuse l’adresse du webhook : vérifiez PUBLIC_URL (les adresses locales sont souvent interdites par GitLab).',
      status,
    )
  }
  return new WebhookInstallError(gitLabErrorMessage(status), status)
}

function gitLabErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return 'Token refusé : invalide, expiré ou révoqué'
    case 403:
      return 'Accès refusé : le token n’a pas les portées nécessaires (read_api)'
    case 404:
      return 'API GitLab introuvable à cette adresse : vérifiez l’URL de l’instance'
    case 429:
      return 'Trop de requêtes : limite de l’API GitLab atteinte, réessayez plus tard'
    default:
      return status >= 500
        ? `GitLab a répondu une erreur serveur (${status})`
        : `Erreur GitLab ${status}`
  }
}
