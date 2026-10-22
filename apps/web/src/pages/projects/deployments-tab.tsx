import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { History, Loader2, RotateCcw, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import type { DeploymentSummary, ProjectView } from '@vercio/shared'
import {
  DeploymentStatusBadge,
  deployedTags,
  deployedVersions,
  duration,
  TRIGGER_LABELS,
} from '@/components/projects/deployment-status'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

export function DeploymentsTab({
  project,
  envId,
  canDeploy,
}: {
  project: ProjectView
  envId: string
  canDeploy: boolean
}) {
  const environment = project.environments.find((env) => env.id === envId)
  const history = useQuery({
    queryKey: ['deployments', 'list', envId],
    queryFn: () => api.deployments.list(project.id, envId),
    enabled: Boolean(envId),
    // En cours : suivi rapproché ; sinon de quoi voir les déploiements lancés ailleurs (webhook).
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status === 'running' || d.status === 'queued')
        ? 3000
        : 30_000,
  })

  if (!environment) {
    return <p className="text-muted-foreground text-sm">Aucun environnement.</p>
  }

  return (
    <div className="space-y-4">
      {history.isPending && <Skeleton className="h-40 w-full" />}
      {history.error && <p className="text-destructive text-sm">{history.error.message}</p>}
      {history.data?.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <History className="text-muted-foreground size-8" />
          <p className="font-medium">Aucun déploiement</p>
          <p className="text-muted-foreground text-sm">
            L’historique de {environment.name} apparaîtra ici.
          </p>
        </div>
      )}
      {Boolean(history.data?.length) && (
        <div className="divide-y rounded-lg border">
          {history.data!.map((deployment) => (
            <DeploymentRow
              key={deployment.id}
              project={project}
              deployment={deployment}
              isCurrent={environment.current?.id === deployment.id}
              canDeploy={canDeploy}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DeploymentRow({
  project,
  deployment,
  isCurrent,
  canDeploy,
}: {
  project: ProjectView
  deployment: DeploymentSummary
  isCurrent: boolean
  canDeploy: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const rollback = useMutation({
    mutationFn: () => api.deployments.rollback(project.id, deployment.environmentId, deployment.id),
    onSuccess: async (created) => {
      toast.success('Retour à cette version lancé')
      await queryClient.invalidateQueries({ queryKey: ['projects', project.slug] })
      await navigate({
        to: '/projets/$slug/deploiements/$deploymentId',
        params: { slug: project.slug, deploymentId: created.id },
      })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
      <DeploymentStatusBadge status={deployment.status} />
      <div className="min-w-0 flex-1">
        <p>
          {/* En service : le tag suivi (`prod`) ; les précédents : le commit qu'il désignait. */}
          <span className="font-mono">
            {isCurrent ? deployedTags(deployment) : deployedVersions(deployment)}
          </span>
          {isCurrent && deployedVersions(deployment) !== deployedTags(deployment) && (
            <span className="text-muted-foreground ml-2 font-mono text-xs">
              {deployedVersions(deployment)}
            </span>
          )}
          {isCurrent && <span className="text-success ml-2 text-xs">en service</span>}
        </p>
        <p className="text-muted-foreground text-xs" title={formatDateTime(deployment.createdAt)}>
          {formatRelative(deployment.createdAt)} · {TRIGGER_LABELS[deployment.trigger]}
          {deployment.username ? ` par ${deployment.username}` : ''}
          {duration(deployment) ? ` · ${duration(deployment)}` : ''}
        </p>
        {deployment.error && (
          <p className="text-destructive truncate text-xs">{deployment.error}</p>
        )}
      </div>
      <Button variant="ghost" size="sm" asChild>
        <Link
          to="/projets/$slug/deploiements/$deploymentId"
          params={{ slug: project.slug, deploymentId: deployment.id }}
        >
          <ScrollText />
          Journal
        </Link>
      </Button>
      {canDeploy && deployment.status === 'succeeded' && !isCurrent && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => rollback.mutate()}
          disabled={rollback.isPending}
        >
          {rollback.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Revenir
        </Button>
      )}
    </div>
  )
}
