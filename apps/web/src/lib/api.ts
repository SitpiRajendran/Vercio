import type {
  AuthConfig,
  ChangePassword,
  BranchSummary,
  ComposeAnalysis,
  ConnectionCheck,
  ContainerActionInput,
  ContainerView,
  CreateProjectInput,
  FirstRunInput,
  DeploymentDetail,
  DeploymentSummary,
  EnvironmentInput,
  DockerInfo,
  GitProviderInput,
  GitProviderView,
  Health,
  LocalLogin,
  LocalLoginResult,
  LogoutResult,
  ProjectInput,
  ProjectSummary,
  ProjectView,
  RegistryImageSuggestion,
  RegistryInput,
  RegistryView,
  RepositorySummary,
  SessionUser,
  TotpCode,
  TotpVerifyResult,
  UserCreateInput,
  UserUpdateInput,
  UserView,
  UserWithPassword,
  TotpSetup,
  VariablesInput,
  VariableView,
  VersionChoices,
  WebhookConfigView,
  WebhookSettings,
  DiskUsageView,
  CleanupPreview,
  CleanupResult,
  CleanupTarget,
  HostContainerView,
  ActivityItem,
  ActivityQuery,
  AuditEntryView,
  AuditQuery,
  ExternalComposeProject,
  RestartPolicy,
  NotificationChannelInput,
  NotificationChannelSecret,
  NotificationChannelView,
  NotificationDeliveryView,
  SmtpSettingsInput,
  SmtpSettingsView,
  ContainerInspectView,
  ContainerStatsView,
  TerminalSettings,
  TerminalShell,
  EnvironmentNetworksInput,
  SharedNetworkInput,
  SharedNetworkUpdate,
  SharedNetworkView,
  OverviewView,
  ContainerUsage,
  ProjectAppearance,
  ResourceAlertSettings,
  BackupDestinationChoice,
  BackupDestinationInput,
  BackupDestinationView,
  BackupDetail,
  BackupEnvironmentPage,
  BackupPlanInput,
  BackupPlanView,
  BackupRestoreInput,
  VercioBackupPage,
  VercioBackupPlanInput,
  TotpDeviceAdd,
  TotpDeviceView,
  EnvironmentLinkInput,
  EnvironmentLinkResult,
  EnvironmentPortsInput,
  UpdateStatus,
  SystemInfo,
} from '@vercio/shared'

export interface CatalogGitProvider {
  id: string
  name: string
  type: 'gitlab' | 'github'
  url: string
}

export interface CatalogRegistry {
  id: string
  name: string
  type: 'gitlab' | 'ghcr' | 'oci'
  url: string
}

export interface EnvironmentUpdate {
  name: string
  sources: { source: string; branch: string; ref: string; mode: 'tracking' | 'locked' }[]
  restartPolicy?: RestartPolicy
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Champ du formulaire concerné, quand l'API le précise. */
    readonly field?: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      field?: string
    } | null
    throw new ApiError(response.status, body?.error ?? `Erreur ${response.status}`, body?.field)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** `?a=1&b=2`, sans les valeurs absentes. */
function queryString(params: object): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body ?? {}),
})

export const api = {
  health: () => request<Health>('/health'),
  authConfig: () => request<AuthConfig>('/auth/config'),
  me: () => request<SessionUser>('/auth/me'),
  login: (body: LocalLogin) =>
    request<LocalLoginResult>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  firstRun: (input: FirstRunInput) => request<LocalLoginResult>('/auth/setup', json('POST', input)),
  totpSetup: () => request<TotpSetup>('/auth/totp/setup', { method: 'POST', body: '{}' }),
  totpVerify: (body: TotpCode) =>
    request<TotpVerifyResult>('/auth/totp/verify', json('POST', body)),
  initialPassword: (password: string) =>
    request<{ ok: true }>('/auth/password/initial', json('POST', { password })),
  changePassword: (body: ChangePassword) => request<void>('/auth/password', json('POST', body)),
  totpDevices: {
    list: () => request<TotpDeviceView[]>('/auth/totp/devices'),
    setup: () => request<TotpSetup>('/auth/totp/devices/setup', json('POST')),
    add: (body: TotpDeviceAdd) => request<TotpDeviceView>('/auth/totp/devices', json('POST', body)),
    remove: (id: string, currentPassword: string) =>
      request<void>(`/auth/totp/devices/${id}`, json('DELETE', { currentPassword })),
  },
  logout: () => request<LogoutResult>('/auth/logout', { method: 'POST' }),
  dockerInfo: () => request<DockerInfo>('/system/docker'),
  system: {
    info: () => request<SystemInfo>('/system/info'),
    update: () => request<UpdateStatus>('/system/update'),
    checkUpdate: () => request<UpdateStatus>('/system/update/check', json('POST')),
    startUpdate: (version: string) =>
      request<UpdateStatus>('/system/update', json('POST', { version })),
  },
  diskUsage: () => request<DiskUsageView[]>('/system/disk'),
  hostContainers: () => request<HostContainerView[]>('/system/containers'),
  cleanup: {
    preview: () => request<CleanupPreview>('/system/cleanup'),
    run: (targets: CleanupTarget[]) =>
      request<CleanupResult>('/system/cleanup', json('POST', { targets })),
  },

  gitProviders: {
    list: () => request<GitProviderView[]>('/settings/git-providers'),
    create: (input: GitProviderInput) =>
      request<GitProviderView>('/settings/git-providers', json('POST', input)),
    update: (id: string, input: GitProviderInput) =>
      request<GitProviderView>(`/settings/git-providers/${id}`, json('PUT', input)),
    remove: (id: string) => request<void>(`/settings/git-providers/${id}`, { method: 'DELETE' }),
    testDraft: (input: GitProviderInput & { id?: string }) =>
      request<ConnectionCheck>('/settings/git-providers/test', json('POST', input)),
    test: (id: string) =>
      request<ConnectionCheck>(`/settings/git-providers/${id}/test`, json('POST')),
    addRegistry: (id: string, url: string) =>
      request<GitProviderView>(`/settings/git-providers/${id}/registry`, json('POST', { url })),
  },

  catalog: {
    gitProviders: () => request<CatalogGitProvider[]>('/catalog/git-providers'),
    registries: () => request<CatalogRegistry[]>('/catalog/registries'),
    repositories: (providerId: string, q: string) =>
      request<RepositorySummary[]>(
        `/catalog/git-providers/${providerId}/repositories?q=${encodeURIComponent(q)}`,
      ),
    branches: (providerId: string, repository: string) =>
      request<BranchSummary[]>(
        `/catalog/git-providers/${providerId}/branches?repository=${encodeURIComponent(repository)}`,
      ),
    images: (providerId: string, repository: string) =>
      request<RegistryImageSuggestion[]>(
        `/catalog/git-providers/${providerId}/images?repository=${encodeURIComponent(repository)}`,
      ),
    composeFiles: (providerId: string, repository: string, ref: string) =>
      request<{ files: string[]; detected: string | null }>(
        `/catalog/git-providers/${providerId}/compose-files?repository=${encodeURIComponent(repository)}&ref=${encodeURIComponent(ref)}`,
      ),
    composeFromGit: (providerId: string, body: { repository: string; ref: string; path: string }) =>
      request<{ content: string; analysis: ComposeAnalysis }>(
        `/catalog/git-providers/${providerId}/compose`,
        json('POST', body),
      ),
    analyze: (content: string) =>
      request<ComposeAnalysis>('/catalog/compose/analyze', json('POST', { content })),
  },

  overview: {
    get: () => request<OverviewView>('/overview'),
    usage: () => request<ContainerUsage[]>('/overview/usage'),
  },

  projects: {
    list: () => request<ProjectSummary[]>('/projects'),
    zeroDowntime: (id: string, services: string[]) =>
      request<ProjectView>(`/projects/${id}/zero-downtime`, json('PUT', { services })),
    appearance: (id: string, input: Partial<ProjectAppearance>) =>
      request<ProjectView>(`/projects/${id}/appearance`, json('PUT', input)),
    get: (slug: string) => request<ProjectView>(`/projects/${encodeURIComponent(slug)}`),
    ports: (id: string, envId: string, input: EnvironmentPortsInput) =>
      request<ProjectView>(`/projects/${id}/environments/${envId}/ports`, json('PUT', input)),
    create: (input: CreateProjectInput) => request<ProjectView>('/projects', json('POST', input)),
    update: (id: string, input: ProjectInput) =>
      request<ProjectView>(`/projects/${id}`, json('PUT', input)),
    remove: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
    createEnvironment: (id: string, input: EnvironmentInput) =>
      request<ProjectView>(`/projects/${id}/environments`, json('POST', input)),
    updateEnvironment: (id: string, envId: string, input: EnvironmentUpdate) =>
      request<ProjectView>(`/projects/${id}/environments/${envId}`, json('PUT', input)),
    removeEnvironment: (id: string, envId: string) =>
      request<void>(`/projects/${id}/environments/${envId}`, { method: 'DELETE' }),
    versions: (id: string, source: string, branch: string, refresh = false) =>
      request<VersionChoices>(
        `/projects/${id}/versions?source=${source}&branch=${encodeURIComponent(branch)}${refresh ? '&refresh=1' : ''}`,
      ),
    imports: () => request<ExternalComposeProject[]>('/projects/imports'),
    variables: (id: string, environmentId?: string) =>
      request<VariableView[]>(
        `/projects/${id}/variables${environmentId ? `?environment=${environmentId}` : ''}`,
      ),
    saveVariables: (id: string, environmentId: string | undefined, input: VariablesInput) =>
      request<void>(
        `/projects/${id}/variables${environmentId ? `?environment=${environmentId}` : ''}`,
        json('PUT', input),
      ),
  },

  deployments: {
    list: (projectId: string, envId: string) =>
      request<DeploymentSummary[]>(`/projects/${projectId}/environments/${envId}/deployments`),
    start: (projectId: string, envId: string) =>
      request<DeploymentSummary>(
        `/projects/${projectId}/environments/${envId}/deployments`,
        json('POST'),
      ),
    rollback: (projectId: string, envId: string, deploymentId: string) =>
      request<DeploymentSummary>(
        `/projects/${projectId}/environments/${envId}/deployments/${deploymentId}/rollback`,
        json('POST'),
      ),
    get: (id: string) => request<DeploymentDetail>(`/deployments/${id}`),
    eventsUrl: (id: string, after: number) => `/api/deployments/${id}/events?after=${after}`,
  },

  containers: {
    list: (projectId: string, envId: string) =>
      request<ContainerView[]>(`/projects/${projectId}/environments/${envId}/containers`),
    action: (projectId: string, envId: string, input: ContainerActionInput) =>
      request<ContainerView[]>(
        `/projects/${projectId}/environments/${envId}/containers/actions`,
        json('POST', input),
      ),
    logsUrl: (projectId: string, envId: string, service: string | null, tail: number) =>
      `/api/projects/${projectId}/environments/${envId}/logs?tail=${tail}${service ? `&service=${encodeURIComponent(service)}` : ''}`,
    stats: (projectId: string, envId: string) =>
      request<ContainerStatsView[]>(
        `/projects/${projectId}/environments/${envId}/containers/stats`,
      ),
    inspect: (projectId: string, envId: string, containerId: string) =>
      request<ContainerInspectView>(
        `/projects/${projectId}/environments/${envId}/containers/${containerId}`,
      ),
    /** Adresse WebSocket du terminal (même origine que l'interface). */
    terminalCheck: (projectId: string, envId: string, containerId: string) =>
      request<{ publicOrigin: string; allowed: boolean; reason: string | null }>(
        `/projects/${projectId}/environments/${envId}/containers/${containerId}/terminal/check`,
      ),
    terminalUrl: (
      projectId: string,
      envId: string,
      containerId: string,
      options: { shell: TerminalShell; cols: number; rows: number },
    ) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${protocol}//${window.location.host}/api/projects/${projectId}/environments/${envId}/containers/${containerId}/terminal${queryString(options)}`
    },
  },

  networks: {
    list: () => request<SharedNetworkView[]>('/networks'),
    create: (input: SharedNetworkInput) =>
      request<SharedNetworkView>('/networks', json('POST', input)),
    update: (id: string, input: SharedNetworkUpdate) =>
      request<SharedNetworkView>(`/networks/${id}`, json('PUT', input)),
    remove: (id: string) =>
      request<{ docker: 'removed' | 'missing' | 'in_use' | 'error' }>(`/networks/${id}`, {
        method: 'DELETE',
      }),
    link: (projectId: string, envId: string, input: EnvironmentLinkInput) =>
      request<EnvironmentLinkResult>(
        `/projects/${projectId}/environments/${envId}/links`,
        json('POST', input),
      ),
    subscribe: (projectId: string, envId: string, input: EnvironmentNetworksInput) =>
      request<SharedNetworkView[]>(
        `/projects/${projectId}/environments/${envId}/networks`,
        json('PUT', input),
      ),
  },

  terminalSettings: {
    get: () => request<TerminalSettings>('/settings/terminal'),
    update: (input: TerminalSettings) =>
      request<TerminalSettings>('/settings/terminal', json('PUT', input)),
  },

  webhooks: {
    get: (projectId: string, envId: string) =>
      request<WebhookConfigView>(`/projects/${projectId}/environments/${envId}/webhooks`),
    regenerate: (projectId: string, envId: string, sourceId: string) =>
      request<WebhookConfigView>(
        `/projects/${projectId}/environments/${envId}/webhooks/${sourceId}/regenerate`,
        json('POST'),
      ),
    install: (projectId: string, envId: string, sourceId: string) =>
      request<WebhookConfigView>(
        `/projects/${projectId}/environments/${envId}/webhooks/${sourceId}/install`,
        json('POST'),
      ),
    saveAllowlist: (projectId: string, envId: string, ipAllowlist: string[]) =>
      request<WebhookConfigView>(
        `/projects/${projectId}/environments/${envId}/webhooks`,
        json('PUT', { ipAllowlist }),
      ),
    settings: () => request<WebhookSettings>('/settings/webhooks'),
    saveSettings: (input: Partial<WebhookSettings>) =>
      request<WebhookSettings>('/settings/webhooks', json('PUT', input)),
  },

  users: {
    list: () => request<UserView[]>('/settings/users'),
    create: (input: UserCreateInput) =>
      request<UserWithPassword>('/settings/users', json('POST', input)),
    update: (id: string, input: UserUpdateInput) =>
      request<UserView>(`/settings/users/${id}`, json('PUT', input)),
    resetPassword: (id: string) =>
      request<UserWithPassword>(`/settings/users/${id}/reset-password`, json('POST')),
    resetTotp: (id: string) => request<UserView>(`/settings/users/${id}/reset-totp`, json('POST')),
    remove: (id: string) => request<void>(`/settings/users/${id}`, { method: 'DELETE' }),
  },

  registries: {
    list: () => request<RegistryView[]>('/settings/registries'),
    create: (input: RegistryInput) =>
      request<RegistryView>('/settings/registries', json('POST', input)),
    update: (id: string, input: RegistryInput) =>
      request<RegistryView>(`/settings/registries/${id}`, json('PUT', input)),
    remove: (id: string) => request<void>(`/settings/registries/${id}`, { method: 'DELETE' }),
    testDraft: (input: RegistryInput & { id?: string }) =>
      request<ConnectionCheck>('/settings/registries/test', json('POST', input)),
    test: (id: string) => request<ConnectionCheck>(`/settings/registries/${id}/test`, json('POST')),
  },

  events: {
    activity: (query: ActivityQuery) =>
      request<ActivityItem[]>(`/events/activity${queryString(query)}`),
  },

  audit: {
    list: (query: AuditQuery) => request<AuditEntryView[]>(`/audit${queryString(query)}`),
    users: () => request<string[]>('/audit/users'),
    /** Lien de téléchargement (cookie de session envoyé par le navigateur). */
    exportUrl: (query: AuditQuery) => `/api/audit/export.csv${queryString(query)}`,
  },

  notifications: {
    channels: () => request<NotificationChannelView[]>('/settings/notifications/channels'),
    create: (input: NotificationChannelInput) =>
      request<NotificationChannelSecret>('/settings/notifications/channels', json('POST', input)),
    update: (id: string, input: NotificationChannelInput) =>
      request<NotificationChannelView>(
        `/settings/notifications/channels/${id}`,
        json('PUT', input),
      ),
    remove: (id: string) =>
      request<void>(`/settings/notifications/channels/${id}`, { method: 'DELETE' }),
    regenerateSecret: (id: string) =>
      request<NotificationChannelSecret>(
        `/settings/notifications/channels/${id}/regenerate-secret`,
        json('POST'),
      ),
    testDraft: (channel: NotificationChannelInput, id?: string) =>
      request<ConnectionCheck>(
        '/settings/notifications/channels/test',
        json('POST', { id, channel }),
      ),
    test: (id: string) =>
      request<ConnectionCheck>(`/settings/notifications/channels/${id}/test`, json('POST')),
    deliveries: (channelId?: string) =>
      request<NotificationDeliveryView[]>(
        `/settings/notifications/deliveries${channelId ? `?channelId=${channelId}` : ''}`,
      ),
    me: () => request<{ email: string | null }>('/settings/notifications/me'),
  },

  resourceAlerts: {
    get: () => request<ResourceAlertSettings>('/settings/resource-alerts'),
    save: (input: ResourceAlertSettings) =>
      request<ResourceAlertSettings>('/settings/resource-alerts', json('PUT', input)),
  },

  smtp: {
    get: () => request<SmtpSettingsView>('/settings/smtp'),
    save: (input: SmtpSettingsInput) =>
      request<SmtpSettingsView>('/settings/smtp', json('PUT', input)),
    remove: () => request<void>('/settings/smtp', { method: 'DELETE' }),
    test: (settings: SmtpSettingsInput, to?: string) =>
      request<ConnectionCheck>('/settings/smtp/test', json('POST', { settings, to })),
  },

  backupDestinations: {
    list: () => request<BackupDestinationView[]>('/settings/backup-destinations'),
    choices: () => request<BackupDestinationChoice[]>('/backup-destinations'),
    create: (input: BackupDestinationInput) =>
      request<BackupDestinationView>('/settings/backup-destinations', json('POST', input)),
    update: (id: string, input: BackupDestinationInput) =>
      request<BackupDestinationView>(`/settings/backup-destinations/${id}`, json('PUT', input)),
    remove: (id: string) =>
      request<void>(`/settings/backup-destinations/${id}`, { method: 'DELETE' }),
    test: (input: BackupDestinationInput, id?: string) =>
      request<ConnectionCheck>(
        '/settings/backup-destinations/test',
        json('POST', { ...input, id }),
      ),
  },

  backups: {
    page: (projectId: string, envId: string) =>
      request<BackupEnvironmentPage>(`/projects/${projectId}/environments/${envId}/backups`),
    detail: (projectId: string, envId: string, backupId: string) =>
      request<BackupDetail>(`/projects/${projectId}/environments/${envId}/backups/${backupId}`),
    savePlan: (projectId: string, envId: string, input: BackupPlanInput) =>
      request<BackupPlanView>(
        `/projects/${projectId}/environments/${envId}/backups/plan`,
        json('PUT', input),
      ),
    removePlan: (projectId: string, envId: string) =>
      request<void>(`/projects/${projectId}/environments/${envId}/backups/plan`, {
        method: 'DELETE',
      }),
    run: (projectId: string, envId: string) =>
      request<{ id: string }>(`/projects/${projectId}/environments/${envId}/backups`, json('POST')),
    restore: (projectId: string, envId: string, backupId: string, input: BackupRestoreInput) =>
      request<{ id: string }>(
        `/projects/${projectId}/environments/${envId}/backups/${backupId}/restore`,
        json('POST', input),
      ),
    remove: (projectId: string, envId: string, backupId: string) =>
      request<void>(`/projects/${projectId}/environments/${envId}/backups/${backupId}`, {
        method: 'DELETE',
      }),
    downloadUrl: (projectId: string, envId: string, backupId: string, item: string) =>
      `/api/projects/${projectId}/environments/${envId}/backups/${backupId}/download${queryString({ item })}`,
  },

  vercioBackup: {
    page: () => request<VercioBackupPage>('/settings/backups/vercio'),
    detail: (backupId: string) => request<BackupDetail>(`/settings/backups/vercio/${backupId}`),
    savePlan: (input: VercioBackupPlanInput) =>
      request<BackupPlanView>('/settings/backups/vercio/plan', json('PUT', input)),
    removePlan: () => request<void>('/settings/backups/vercio/plan', { method: 'DELETE' }),
    run: () => request<{ id: string }>('/settings/backups/vercio', json('POST')),
    restore: (backupId: string, confirm: string) =>
      request<{ ok: true }>(
        `/settings/backups/vercio/${backupId}/restore`,
        json('POST', { confirm }),
      ),
    remove: (backupId: string) =>
      request<void>(`/settings/backups/vercio/${backupId}`, { method: 'DELETE' }),
    downloadUrl: (backupId: string) =>
      `/api/settings/backups/vercio/${backupId}/download${queryString({ item: 'database:vercio' })}`,
  },
}
