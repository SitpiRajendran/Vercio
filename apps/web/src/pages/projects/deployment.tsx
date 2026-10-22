import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { hasRole, type DeploymentDetail } from '@vercio/shared'
import { PageHeader } from '@/components/layout/app-layout'
import { DeploymentLog, useDeploymentStream } from '@/components/projects/deployment-log'
import {
  DeploymentStatusBadge,
  deployedLabel,
  duration,
  isFinal,
  TRIGGER_LABELS,
} from '@/components/projects/deployment-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'

export function DeploymentPage() {
  const { slug, deploymentId } = useParams({
    from: '/app/projets/$slug/deploiements/$deploymentId',
  })
  const { data: user } = useCurrentUser()
  const detail = useQuery({
    queryKey: ['deployments', deploymentId],
    queryFn: () => api.deployments.get(deploymentId),
  })

  if (detail.isPending) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }
  if (detail.error) return <p className="text-destructive p-6 text-sm">{detail.error.message}</p>
  return (
    <DeploymentView
      key={detail.data.id}
      detail={detail.data}
      slug={slug}
      canDeploy={user ? hasRole(user.roles, 'vercio-deployer') : false}
    />
  )
}

/** Remonté pour chaque déploiement : l'état du flux en direct part du détail chargé. */
function DeploymentView({
  detail,
  slug,
  canDeploy,
}: {
  detail: DeploymentDetail
  slug: string
  canDeploy: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const project = useQuery({ queryKey: ['projects', slug], queryFn: () => api.projects.get(slug) })
  const { logs, summary } = useDeploymentStream(detail)
  // Retour automatique lancé par l'échec de ce déploiement (connu en direct par le journal).
  const autoRollbackId =
    detail.autoRollbackId ??
    logs
      .map((log) => /Retour automatique.*\(déploiement ([0-9a-f-]{36})\)/.exec(log.line)?.[1])
      .find(Boolean) ??
    null
  const environment = project.data?.environments.find((env) => env.id === summary.environmentId)
  const isCurrent = environment?.current?.id === summary.id

  const rollback = useMutation({
    mutationFn: () => api.deployments.rollback(project.data!.id, summary.environmentId, summary.id),
    onSuccess: async (deployment) => {
      toast.success('Retour à cette version lancé')
      await queryClient.invalidateQueries({ queryKey: ['projects', slug] })
      await navigate({
        to: '/projets/$slug/deploiements/$deploymentId',
        params: { slug, deploymentId: deployment.id },
      })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <>
      <PageHeader
        title={`Déploiement ${detail.environmentName}`}
        description={`${project.data?.name ?? slug} · ${formatDateTime(summary.createdAt)}`}
        actions={<DeploymentStatusBadge status={summary.status} />}
      />
      <div className="space-y-4 p-4 md:p-6">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/projets/$slug" params={{ slug }}>
            <ArrowLeft />
            Retour au projet
          </Link>
        </Button>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <DeploymentLog logs={logs} live={!isFinal(summary.status)} />

          <Card className="gap-3 self-start">
            <CardHeader>
              <CardTitle>Détails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Info label="Déclenchement">
                {TRIGGER_LABELS[summary.trigger]}
                {summary.username ? ` par ${summary.username}` : ''}
              </Info>
              <Info label="Version">{deployedLabel(summary)}</Info>
              {duration(summary) && <Info label="Durée">{duration(summary)}</Info>}
              {Object.keys(summary.images).length > 0 && (
                <Info label="Images">
                  <ul className="space-y-1">
                    {Object.entries(summary.images).map(([service, image]) => (
                      <li key={service} className="break-all">
                        <span className="font-medium">{service}</span>{' '}
                        <span className="text-muted-foreground font-mono text-xs" title={image}>
                          {image.split('@')[1]?.slice(0, 19)}…
                        </span>
                      </li>
                    ))}
                  </ul>
                </Info>
              )}
              {autoRollbackId && (
                <Button variant="secondary" className="w-full" asChild>
                  <Link
                    to="/projets/$slug/deploiements/$deploymentId"
                    params={{ slug, deploymentId: autoRollbackId }}
                  >
                    <Undo2 />
                    Voir le retour automatique
                  </Link>
                </Button>
              )}
              {summary.error && (
                <p className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-2 text-xs">
                  {summary.error}
                </p>
              )}
              {canDeploy && summary.status === 'succeeded' && !isCurrent && environment && (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => rollback.mutate()}
                  disabled={rollback.isPending}
                >
                  {rollback.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  Revenir à cette version
                </Button>
              )}
              {isCurrent && (
                <p className="text-success text-xs">Version actuellement en service.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div>{children}</div>
    </div>
  )
}
