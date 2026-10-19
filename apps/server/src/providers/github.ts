import type { GitTag } from './git.js'
import {
  gitProviderApiUrl,
  type BranchSummary,
  type ConnectionCheck,
  type RegistryImageSuggestion,
  type RepositorySummary,
} from '@vercio/shared'
import { describeNetworkError, httpRequest, type HttpOptions } from '../lib/http.js'
import { CheckReport } from './check.js'
import { WebhookInstallError, type WebhookSpec } from './webhook-install.js'

export interface GitHubSettings extends HttpOptions {
  /** URL de l'instance : https://github.com ou https://github.example.com (Enterprise Server) */
  url: string
  token: string
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface GitHubResponse<T> {
  body: T
  headers: Headers
}

/** Client de l'API REST de GitHub (GitHub.com et GitHub Enterprise Server). */
export class GitHubClient {
  constructor(private readonly settings: GitHubSettings) {}

  get apiUrl(): string {
    return gitProviderApiUrl('github', this.settings.url)
  }

  async request<T>(path: string): Promise<GitHubResponse<T>> {
    const response = await this.fetch(path, 'application/vnd.github+json')
    return { body: (await response.json()) as T, headers: response.headers as unknown as Headers }
  }

  /** Écriture (webhooks) : la réponse est rendue telle quelle, l'appelant interprète le code. */
  private send(method: string, path: string, body?: object) {
    return httpRequest(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.settings.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Vercio',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      this.settings,
    )
  }

  async installWebhook(repository: string, hook: WebhookSpec): Promise<{ id: string }> {
    const body = {
      active: true,
      // Le déploiement suit la fin des workflows, pas les pushs eux-mêmes.
      events: ['workflow_run'],
      config: {
        url: hook.url,
        content_type: 'json',
        secret: hook.secret,
        insecure_ssl: '0',
      },
    }
    if (hook.existingId) {
      const updated = await this.send(
        'PATCH',
        `/repos/${repository}/hooks/${hook.existingId}`,
        body,
      )
      if (updated.ok) return { id: String(((await updated.json()) as { id: number }).id) }
      if (updated.status !== 404) throw gitHubHookError(updated.status)
    }
    const created = await this.send('POST', `/repos/${repository}/hooks`, { name: 'web', ...body })
    if (!created.ok) throw gitHubHookError(created.status)
    return { id: String(((await created.json()) as { id: number }).id) }
  }

  async removeWebhook(repository: string, id: string): Promise<void> {
    const response = await this.send('DELETE', `/repos/${repository}/hooks/${id}`)
    if (!response.ok && response.status !== 404) throw gitHubHookError(response.status)
  }

  private async fetch(path: string, accept: string) {
    const response = await httpRequest(
      `${this.apiUrl}${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.settings.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Vercio',
        },
      },
      this.settings,
    )
    if (response.status >= 300 && response.status < 400) {
      throw new GitHubApiError(
        response.status,
        `Redirection inattendue vers ${response.headers.get('location') ?? '?'} : vérifiez l’URL`,
      )
    }
    if (!response.ok) {
      throw new GitHubApiError(response.status, gitHubErrorMessage(response))
    }
    return response
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).body
  }

  async searchRepositories(query: string): Promise<RepositorySummary[]> {
    const repos = await this.get<
      {
        full_name: string
        name: string
        default_branch: string
        html_url: string
        private: boolean
      }[]
    >('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member')
    const needle = query.toLowerCase()
    return repos
      .filter((repo) => !needle || repo.full_name.toLowerCase().includes(needle))
      .slice(0, 20)
      .map((repo) => ({
        fullName: repo.full_name,
        name: repo.name,
        defaultBranch: repo.default_branch,
        webUrl: repo.html_url,
        private: repo.private,
      }))
  }

  async listBranches(repository: string): Promise<BranchSummary[]> {
    const [repo, branches] = await Promise.all([
      this.get<{ default_branch: string }>(`/repos/${repository}`),
      this.get<{ name: string }[]>(`/repos/${repository}/branches?per_page=100`),
    ])
    return branches.map((branch) => ({
      name: branch.name,
      isDefault: branch.name === repo.default_branch,
    }))
  }

  async getFile(repository: string, path: string, ref: string): Promise<string> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    try {
      const response = await this.fetch(
        `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        'application/vnd.github.raw+json',
      )
      return await response.text()
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new GitHubApiError(404, `Fichier ${path} introuvable sur la branche ${ref}`)
      }
      throw error
    }
  }

  /** Arborescence complète en un appel (GitHub la tronque au-delà de 100 000 entrées). */
  async listFiles(repository: string, ref: string): Promise<string[]> {
    const tree = await this.get<{ tree: { path: string; type: string }[] }>(
      `/repos/${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )
    return tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  }

  async listCommits(repository: string, branch: string, limit: number): Promise<GitTag[]> {
    const commits = await this.get<
      { sha: string; commit: { message: string; author: { name: string; date: string } | null } }[]
    >(`/repos/${repository}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`)
    return commits.map((commit) => ({
      name: commit.sha,
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0] ?? null,
      author: commit.commit.author?.name ?? null,
      date: commit.commit.author?.date ?? null,
    }))
  }

  /** Tags : l'API ne donne que le commit ; les détails sont lus à la demande (commitDetails). */
  async listTags(repository: string): Promise<GitTag[]> {
    const tags = await this.get<{ name: string; commit: { sha: string } }[]>(
      `/repos/${repository}/tags?per_page=100`,
    )
    return tags.map((tag) => ({
      name: tag.name,
      sha: tag.commit.sha,
      message: null,
      author: null,
      date: null,
    }))
  }

  async commitDetails(repository: string, sha: string): Promise<Partial<GitTag>> {
    const commit = await this.get<{
      commit: { message: string; author: { name: string; date: string } }
    }>(`/repos/${repository}/commits/${sha}`)
    return {
      message: commit.commit.message.split('\n')[0] ?? null,
      author: commit.commit.author.name,
      date: commit.commit.author.date,
    }
  }

  /** Le commit est contenu dans la branche si la branche est « en avance » ou identique. */
  async isCommitOnBranch(repository: string, sha: string, branch: string): Promise<boolean> {
    const comparison = await this.get<{ status: string }>(
      `/repos/${repository}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch)}`,
    )
    return comparison.status === 'ahead' || comparison.status === 'identical'
  }

  commitUrl(repository: string, sha: string): string {
    return `${this.settings.url}/${repository}/commit/${sha}`
  }

  pipelineUrl(repository: string, ref: string): string {
    return `${this.settings.url}/${repository}/actions?query=${encodeURIComponent(`branch:${ref}`)}`
  }

  /** Images GHCR publiées depuis ce dépôt (nécessite read:packages). */
  async registryImages(repository: string): Promise<RegistryImageSuggestion[]> {
    const owner = repository.split('/')[0]!
    const list = (scope: string) =>
      this.get<{ name: string; repository?: { full_name: string } }[]>(
        `/${scope}/${owner}/packages?package_type=container&per_page=100`,
      )
    const packages = await list('orgs')
      .catch(() => list('users'))
      .catch(() => [])
    return packages
      .filter((pkg) => pkg.repository?.full_name.toLowerCase() === repository.toLowerCase())
      .map((pkg) => ({ host: 'ghcr.io', path: `${owner.toLowerCase()}/${pkg.name}` }))
  }

  async check(): Promise<ConnectionCheck> {
    const report = new CheckReport()
    try {
      const { body: user, headers } = await this.request<{ login: string; type: string }>('/user')
      const kind = tokenKind(this.settings.token)
      report.detail('Compte', user.login).detail('Type de token', kind.label)

      const meta = await this.get<{ installed_version?: string }>('/meta').catch(() => null)
      report.detail(
        'Instance',
        meta?.installed_version
          ? `GitHub Enterprise Server ${meta.installed_version}`
          : this.apiUrl === 'https://api.github.com'
            ? 'GitHub.com'
            : 'GitHub Enterprise',
      )

      const scopes = headers.get('x-oauth-scopes')
      if (kind.classic) {
        const list = (scopes ?? '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
        report.detail('Portées', list.join(', ') || 'aucune')
        checkClassicScopes(list, report)
      } else if (kind.fineGrained) {
        report.warn(
          'Token fine-grained : accordez Contents et Metadata en lecture sur les dépôts concernés. Il ne donne pas accès à GHCR : utilisez un token classique read:packages pour le registry.',
        )
      }

      const expiration = headers.get('github-authentication-token-expiration')
      report.detail('Expiration', expiration ?? 'aucune')
      if (expiration) {
        const days = Math.floor((Date.parse(expiration) - Date.now()) / 86_400_000)
        if (days < 30) report.warn(`Le token expire dans ${Math.max(days, 0)} jour(s).`)
      }

      const remaining = headers.get('x-ratelimit-remaining')
      const limit = headers.get('x-ratelimit-limit')
      if (remaining && limit)
        report.detail('Quota d’API', `${remaining} / ${limit} requêtes restantes`)

      return report.ok(`Connecté à GitHub en tant que ${user.login}`)
    } catch (error) {
      return report.fail(
        error instanceof GitHubApiError ? error.message : describeNetworkError(error),
      )
    }
  }
}

function tokenKind(token: string) {
  if (token.startsWith('github_pat_'))
    return { label: 'fine-grained', classic: false, fineGrained: true }
  if (token.startsWith('ghp_')) return { label: 'classique', classic: true, fineGrained: false }
  if (token.startsWith('ghs_'))
    return { label: 'application GitHub', classic: false, fineGrained: false }
  if (token.startsWith('gho_')) return { label: 'OAuth', classic: true, fineGrained: false }
  return { label: 'inconnu', classic: true, fineGrained: false }
}

function checkClassicScopes(scopes: string[], report: CheckReport) {
  const has = (scope: string) => scopes.includes(scope)
  if (!has('repo')) {
    report.warn('Portée repo absente : seuls les dépôts publics seront lisibles.')
  } else {
    report.warn(
      'La portée repo d’un token classique donne aussi l’écriture sur vos dépôts. Pour limiter les droits : un token fine-grained en lecture seule ici, et un token classique limité à read:packages dans le registry GHCR.',
    )
  }
  if (!has('read:packages') && !has('write:packages')) {
    report.warn('Portée read:packages absente : nécessaire pour tirer les images de GHCR.')
  }
  if (has('write:packages') || has('delete:packages') || has('admin:org')) {
    report.warn('Ce token a des droits d’écriture ou d’administration dont Vercio n’a pas besoin.')
  }
}

function gitHubHookError(status: number): WebhookInstallError {
  // GitHub répond 404 (et non 403) quand le token n'a pas le droit d'administrer le dépôt.
  if (status === 401 || status === 403 || status === 404) {
    return new WebhookInstallError(
      'Le token ne peut pas créer de webhook : token classique avec la portée « admin:repo_hook » (ou « repo ») et droits d’administration du dépôt, ou token fine-grained avec « Webhooks » en écriture.',
      status,
    )
  }
  if (status === 422) {
    return new WebhookInstallError(
      'GitHub refuse l’adresse du webhook : vérifiez PUBLIC_URL (elle doit être joignable depuis Internet).',
      status,
    )
  }
  return new WebhookInstallError(`Erreur GitHub ${status}`, status)
}

function gitHubErrorMessage(response: {
  status: number
  headers: { get(name: string): string | null }
}): string {
  switch (response.status) {
    case 401:
      return 'Token refusé : invalide, expiré ou révoqué'
    case 403:
      return response.headers.get('x-ratelimit-remaining') === '0'
        ? 'Quota de l’API GitHub épuisé : réessayez plus tard'
        : 'Accès refusé : le token n’a pas les droits nécessaires'
    case 404:
      return 'API GitHub introuvable à cette adresse : vérifiez l’URL de l’instance'
    default:
      return response.status >= 500
        ? `GitHub a répondu une erreur serveur (${response.status})`
        : `Erreur GitHub ${response.status}`
  }
}
