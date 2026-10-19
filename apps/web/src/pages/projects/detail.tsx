import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import type { EnvironmentView, OverviewEnvironment, ProjectView } from '@vercio/shared'
import { useContainerActions } from '@/components/containers/container-actions'
import { LogViewer } from '@/components/containers/log-viewer'
import { PageHeader } from '@/components/layout/app-layout'
import { StickyTabsList } from '@/components/layout/sticky-tabs-list'
import { AppearanceDialog } from '@/components/projects/appearance-dialog'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import {
  BackupLine,
  envTarget,
  EnvironmentActions,
  EnvironmentPills,
  useChosenEnvironment,
  VersionLine,
} from '@/components/projects/project-overview-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs'
import { useWorkbench } from '@/components/workbench/workbench'
import { api } from '@/lib/api'
import { environmentStatus, TONE_DOT, TONE_TEXT, useOverview } from '@/lib/overview'
import { cn } from '@/lib/utils'
import { BackupsTab } from './backups-tab'
import { DeploymentsTab } from './deployments-tab'
import { MapTab } from './map-tab'
import { OverviewTab } from './overview-tab'
import { SettingsTab } from './settings-tab'
import { VariablesTab } from './variables-tab'

const TABS = [
  'apercu',
  'logs',
  'deploiements',
  'variables',
  'carte',
  'sauvegardes',
  'parametres',
] as const
type Tab = (typeof TABS)[number]

/** Anciens liens (notifications, favoris) vers les onglets d'avant. */
const LEGACY_TABS: Record<string, Tab> = {
  conteneurs: 'apercu',
  environnements: 'parametres',
  webhooks: 'parametres',
  services: 'parametres',
  configuration: 'parametres',
}

export function ProjectDetailPage() {
  const { slug } = useParams({ from: '/app/projets/$slug' })
  const search = useSearch({ from: '/app/projets/$slug' })
  const project = useQuery({
    queryKey: ['projects', slug],
    queryFn: () => api.projects.get(slug),
    // Rafraîchit les statuts tant qu'un déploiement est en cours.
    refetchInterval: (query) =>
      query.state.data?.environments.some(
        (env) =>
          env.lastDeployment?.status === 'running' || env.lastDeployment?.status === 'queued',
      )
        ? 3000
        : false,
  })

  if (project.isPending) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (project.error) {
    return (
      <>
        <PageHeader title="Projet" />
        <p className="text-destructive p-6 text-sm">{project.error.message}</p>
      </>
    )
  }
  return <ProjectPage key={project.data.id} project={project.data} initialEnv={search.env} />
}

function ProjectPage({ project, initialEnv }: { project: ProjectView; initialEnv?: string }) {
  const search = useSearch({ from: '/app/projets/$slug' })
  const navigate = useNavigate()
  const go = (next: { onglet?: string; env?: string }) =>
    void navigate({
      to: '/projets/$slug',
      params: { slug: project.slug },
      search: { ...search, ...next },
      replace: true,
    })
  const workbench = useWorkbench()
  const overview = useOverview()
  const [environment, choose] = useChosenEnvironment(project, initialEnv)
  const [editingAppearance, setEditingAppearance] = useState(false)
  const tab: Tab =
    TABS.find((item) => item === search.onglet) ?? LEGACY_TABS[search.onglet ?? ''] ?? 'apercu'
  const live = overview.data?.projects
    .find((item) => item.id === project.id)
    ?.environments.find((env) => env.id === environment?.id)

  if (!environment) {
    return (
      <>
        <PageHeader title={project.name} />
        <p className="text-muted-foreground p-6 text-sm">Aucun environnement.</p>
      </>
    )
  }

  return (
    <EnvironmentPage
      key={environment.id}
      project={project}
      environment={environment}
      live={live}
      environments={overview.data?.projects.find((item) => item.id === project.id)?.environments}
      onChooseEnvironment={(id) => {
        choose(id)
        const slug = project.environments.find((env) => env.id === id)?.slug
        go({ env: slug })
      }}
      tab={tab}
      onTab={(next) => go({ onglet: next })}
      can={{ canDeploy: workbench.canDeploy, isAdmin: workbench.isAdmin }}
      onEditAppearance={workbench.isAdmin ? () => setEditingAppearance(true) : undefined}
      appearanceDialog={
        editingAppearance && (
          <AppearanceDialog project={project} onClose={() => setEditingAppearance(false)} />
        )
      }
    />
  )
}

function EnvironmentPage({
  project,
  environment,
  live,
  environments,
  onChooseEnvironment,
  tab,
  onTab,
  can,
  onEditAppearance,
  appearanceDialog,
}: {
  project: ProjectView
  environment: EnvironmentView
  live: OverviewEnvironment | undefined
  environments: OverviewEnvironment[] | undefined
  onChooseEnvironment: (id: string) => void
  tab: Tab
  onTab: (tab: Tab) => void
  can: { canDeploy: boolean; isAdmin: boolean }
  onEditAppearance?: () => void
  appearanceDialog: React.ReactNode
}) {
  const target = envTarget(project, environment)
  const actions = useContainerActions(target)
  const status = live ? environmentStatus(live) : null
  const services = [...new Set(live?.containers.map((container) => container.service))].sort()
  const [logService, setLogService] = useState<string | null>(null)

  return (
    <>
      <PageHeader
        leading={
          onEditAppearance ? (
            <button
              type="button"
              onClick={onEditAppearance}
              className="group relative shrink-0 rounded-xl"
              aria-label="Changer l’icône ou l’image du projet"
              title="Changer l’icône ou l’image"
            >
              <ProjectAvatar project={project} size="lg" />
              <span className="bg-background absolute -right-1 -bottom-1 rounded-full border p-0.5 opacity-70 group-hover:opacity-100">
                <Pencil className="size-3" />
              </span>
            </button>
          ) : (
            <ProjectAvatar project={project} size="lg" />
          )
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.name}
            {environments && (
              <EnvironmentPills
                environments={environments}
                value={environment.id}
                onChange={onChooseEnvironment}
              />
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 text-xs">
            {status && (
              <span className={cn('flex items-center gap-1.5 font-medium', TONE_TEXT[status.tone])}>
                <span className={cn('size-2 rounded-full', TONE_DOT[status.tone])} aria-hidden />
                {status.label}
              </span>
            )}
            {live && <VersionLine env={live} />}
            {live && <BackupLine env={live} projectSlug={project.slug} />}
            {project.description && <span>· {project.description}</span>}
          </span>
        }
        actions={
          live && (
            <EnvironmentActions target={target} env={live} actions={actions} url={project.url} />
          )
        }
      />
      <div className="p-4 md:p-6">
        <Tabs value={tab} onValueChange={(value) => onTab(value as Tab)}>
          <StickyTabsList>
            <TabsTrigger value="apercu">Vue d’ensemble</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="deploiements">Déploiements</TabsTrigger>
            <TabsTrigger value="variables">Variables</TabsTrigger>
            <TabsTrigger value="carte">Carte</TabsTrigger>
            <TabsTrigger value="sauvegardes">Sauvegardes</TabsTrigger>
            <TabsTrigger value="parametres">Paramètres</TabsTrigger>
          </StickyTabsList>
          <TabsContent value="apercu" className="pt-4">
            <OverviewTab
              project={project}
              environment={environment}
              live={live}
              target={target}
              actions={actions}
              isAdmin={can.isAdmin}
            />
          </TabsContent>
          <TabsContent value="logs" className="pt-4">
            <LogViewer
              className="h-[calc(100svh-15rem)] min-h-96"
              projectId={project.id}
              envId={environment.id}
              service={logService}
              services={services}
              onServiceChange={setLogService}
              downloadName={`${project.slug}-${environment.slug}`}
            />
          </TabsContent>
          <TabsContent value="deploiements" className="pt-4">
            <DeploymentsTab project={project} envId={environment.id} canDeploy={can.canDeploy} />
          </TabsContent>
          <TabsContent value="variables" className="pt-4">
            <VariablesTab
              project={project}
              environmentId={environment.id}
              canEdit={can.canDeploy}
            />
          </TabsContent>
          <TabsContent value="carte" className="pt-4">
            <MapTab project={project} environment={environment} live={live} />
          </TabsContent>
          <TabsContent value="sauvegardes" className="pt-4">
            <BackupsTab
              project={project}
              envId={environment.id}
              envName={environment.name}
              can={can}
            />
          </TabsContent>
          <TabsContent value="parametres" className="pt-4">
            <SettingsTab project={project} envId={environment.id} can={can} />
          </TabsContent>
        </Tabs>
      </div>
      {actions.dialog}
      {appearanceDialog}
    </>
  )
}
