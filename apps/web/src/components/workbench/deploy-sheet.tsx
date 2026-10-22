import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, ExternalLink, GitBranch, Loader2, Lock, Rocket, XCircle } from 'lucide-react'
import type { DeploymentDetail, ProjectView } from '@vercio/shared'
import { LogViewer } from '@/components/containers/log-viewer'
import { DeploymentLog, useDeploymentStream } from '@/components/projects/deployment-log'
import {
  DeploymentStatusBadge,
  deployedTags,
  isFinal,
} from '@/components/projects/deployment-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { EnvTarget } from './workbench'

/**
 * Mise à jour d'un environnement sans quitter la page : confirmation, journal en direct,
 * puis logs des conteneurs démarrés.
 */
export function DeploySheet({
  target,
  onClose,
}: {
  target: EnvTarget | null
  onClose: () => void
}) {
  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        {target && <DeployPanel key={target.envId} target={target} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  )
}

function DeployPanel({ target, onClose }: { target: EnvTarget; onClose: () => void }) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['projects', target.projectSlug],
    queryFn: () => api.projects.get(target.projectSlug),
  })
  const environment = project.data?.environments.find((env) => env.id === target.envId)
  // Un déploiement déjà en cours est suivi directement.
  const running =
    environment?.lastDeployment &&
    (environment.lastDeployment.status === 'queued' ||
      environment.lastDeployment.status === 'running')
      ? environment.lastDeployment.id
      : null
  const [started, setStarted] = useState<string | null>(null)
  const deploymentId = started ?? running

  const deploy = useMutation({
    mutationFn: () => api.deployments.start(target.projectId, target.envId),
    onSuccess: (deployment) => {
      setStarted(deployment.id)
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      void queryClient.invalidateQueries({ queryKey: ['deployments', 'list', target.envId] })
    },
  })

  return (
    <>
      <SheetHeader className="pr-10">
        <SheetTitle className="flex items-center gap-2">
          <Rocket className="size-4" />
          {environment && !environment.current ? 'Déployer' : 'Mettre à jour'} {target.projectName}
        </SheetTitle>
        <SheetDescription>{target.envName}</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {project.isPending && <Skeleton className="h-32 w-full" />}
        {project.data && environment && !deploymentId && (
          <Confirm
            project={project.data}
            envId={target.envId}
            pending={deploy.isPending}
            error={deploy.error?.message ?? null}
            onDeploy={() => deploy.mutate()}
            onCancel={onClose}
          />
        )}
        {deploymentId && <Progress target={target} deploymentId={deploymentId} />}
      </div>
    </>
  )
}

function Confirm({
  project,
  envId,
  pending,
  error,
  onDeploy,
  onCancel,
}: {
  project: ProjectView
  envId: string
  pending: boolean
  error: string | null
  onDeploy: () => void
  onCancel: () => void
}) {
  const environment = project.environments.find((env) => env.id === envId)!
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {environment.current
          ? 'Vercio télécharge les images (pull), puis remplace les conteneurs. Si le démarrage échoue, la dernière version saine est rétablie automatiquement.'
          : 'Vercio télécharge les images (pull), puis crée et démarre les conteneurs.'}
      </p>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">Version déployée</p>
        {environment.sources.length === 0 && (
          <p className="text-muted-foreground">
            Images écrites dans le fichier Compose, téléchargées à nouveau.
          </p>
        )}
        {environment.sources.map((source) => {
          const info = project.sources.find((item) => item.id === source.appSourceId)
          return (
            <div key={source.appSourceId} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{info?.repository}</span>
              <Badge variant="secondary" className="gap-1">
                <GitBranch className="size-3" />
                {source.branch}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {source.ref === 'latest' ? 'dernier build' : source.ref}
              </Badge>
              {source.mode === 'locked' && (
                <Badge variant="outline" className="text-warning gap-1">
                  <Lock className="size-3" />
                  verrouillée
                </Badge>
              )}
            </div>
          )
        })}
        {environment.current && (
          <p className="text-muted-foreground text-xs">
            En service : <span className="font-mono">{deployedTags(environment.current)}</span>
          </p>
        )}
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
        <Button onClick={onDeploy} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Rocket />}
          Télécharger et déployer
        </Button>
      </div>
    </div>
  )
}

function Progress({ target, deploymentId }: { target: EnvTarget; deploymentId: string }) {
  const detail = useQuery({
    queryKey: ['deployments', deploymentId],
    queryFn: () => api.deployments.get(deploymentId),
  })
  if (detail.isPending) return <Skeleton className="h-64 w-full" />
  if (detail.error) return <p className="text-destructive text-sm">{detail.error.message}</p>
  return <Stream key={detail.data.id} target={target} detail={detail.data} />
}

function Stream({ target, detail }: { target: EnvTarget; detail: DeploymentDetail }) {
  const queryClient = useQueryClient()
  const { logs, summary } = useDeploymentStream(detail)
  const done = isFinal(summary.status)
  const [refreshed, setRefreshed] = useState(false)
  if (done && !refreshed) {
    setRefreshed(true)
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
    void queryClient.invalidateQueries({ queryKey: ['projects', target.projectSlug] })
    void queryClient.invalidateQueries({ queryKey: ['events'] })
    void queryClient.invalidateQueries({ queryKey: ['deployments', 'list', target.envId] })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DeploymentStatusBadge status={summary.status} />
        <span className="text-muted-foreground text-xs">{done ? '' : 'Journal en direct'}</span>
        <Button variant="ghost" size="sm" className="ml-auto" asChild>
          <Link
            to="/projets/$slug/deploiements/$deploymentId"
            params={{ slug: target.projectSlug, deploymentId: summary.id }}
          >
            <ExternalLink />
            Page du déploiement
          </Link>
        </Button>
      </div>
      {done && summary.status === 'succeeded' && (
        <p className="text-success flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="size-4" />
          En ligne
          {Object.keys(summary.versions).length ? ` : ${deployedTags(summary)}` : ''}
        </p>
      )}
      {done && summary.status !== 'succeeded' && (
        <div className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <XCircle className="text-destructive size-4" />
            Le déploiement a échoué
          </p>
          {summary.error && <p className="text-muted-foreground mt-1 text-xs">{summary.error}</p>}
        </div>
      )}
      <DeploymentLog logs={logs} live={!done} />
      {done && (
        <div className="flex h-[26rem] flex-col gap-2">
          <p className="text-sm font-medium">Logs des conteneurs</p>
          <LogViewer
            className="min-h-0 flex-1"
            projectId={target.projectId}
            envId={target.envId}
            service={null}
            downloadName={`${target.projectSlug}-${target.envName}`}
          />
        </div>
      )}
    </div>
  )
}
