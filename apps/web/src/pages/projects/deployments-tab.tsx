import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  RotateCcw,
  ScrollText,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import type { DeploymentSummary, ProjectView } from '@vercio/shared'
import {
  DeploymentStatusBadge,
  deployedTags,
  duration,
  TRIGGER_LABELS,
} from '@/components/projects/deployment-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
        <DeploymentTable
          project={project}
          deployments={history.data!}
          currentId={environment.current?.id ?? null}
          canDeploy={canDeploy}
        />
      )}
    </div>
  )
}

const PAGE_SIZES = [10, 25, 50]

/** Texte cherché : commit, message, version, auteur, erreur. */
function searchable(deployment: DeploymentSummary): string {
  const versions = Object.values(deployment.versions)
  return [
    ...versions.flatMap((version) => [
      version.tag,
      version.version,
      version.commit?.sha,
      version.commit?.message,
      version.commit?.author,
    ]),
    deployment.username,
    deployment.error,
    TRIGGER_LABELS[deployment.trigger],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Historique en tableau : statut, commit et message, version suivie, déclencheur, durée. */
function DeploymentTable({
  project,
  deployments,
  currentId,
  canDeploy,
}: {
  project: ProjectView
  deployments: DeploymentSummary[]
  currentId: string | null
  canDeploy: boolean
}) {
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(0)
  const filtered = query.trim()
    ? deployments.filter((item) => searchable(item).includes(query.trim().toLowerCase()))
    : deployments
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pages - 1)
  const shown = filtered.slice(current * pageSize, (current + 1) * pageSize)

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="border-b p-2">
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="pl-8"
            placeholder="Chercher un commit, un message, une personne…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Statut</th>
              <th className="px-3 py-2 font-medium">Commit</th>
              <th className="px-3 py-2 font-medium">Version</th>
              <th className="px-3 py-2 font-medium">Déclencheur</th>
              <th className="px-3 py-2 font-medium">Lancé</th>
              <th className="px-3 py-2 font-medium">Durée</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((deployment) => (
              <DeploymentRow
                key={deployment.id}
                project={project}
                deployment={deployment}
                isCurrent={currentId === deployment.id}
                canDeploy={canDeploy}
              />
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted-foreground px-3 py-6 text-center">
                  Aucun déploiement ne correspond.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span>
            {filtered.length ? current * pageSize + 1 : 0}–
            {Math.min((current + 1) * pageSize, filtered.length)} sur {filtered.length}
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              setPageSize(Number(value))
              setPage(0)
            }}
          >
            <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs" aria-label="Par page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Page précédente"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Page suivante"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
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

  const commit = Object.values(deployment.versions).find((version) => version.commit)?.commit
  const tags = deployedTags(deployment)

  return (
    <tr className="align-top">
      <td className="px-3 py-2.5">
        <DeploymentStatusBadge status={deployment.status} />
      </td>
      <td className="max-w-[28rem] min-w-56 px-3 py-2.5">
        {commit ? (
          <p className="flex min-w-0 items-baseline gap-2">
            <a
              href={commit.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-xs underline-offset-4 hover:underline"
              title={commit.sha}
            >
              {commit.shortSha.slice(0, 7)}
            </a>
            <span className="truncate" title={commit.message ?? undefined}>
              {commit.message ?? ''}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {Object.keys(deployment.versions).length ? 'commit inconnu' : 'images fixes'}
          </p>
        )}
        {commit?.author && <p className="text-muted-foreground text-xs">{commit.author}</p>}
        {deployment.error && (
          <p className="text-destructive truncate text-xs" title={deployment.error}>
            {deployment.error}
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className="font-mono text-xs">{tags}</span>
        {isCurrent && <span className="text-success ml-2 text-xs">en service</span>}
      </td>
      <td className="text-muted-foreground px-3 py-2.5 text-xs whitespace-nowrap">
        {TRIGGER_LABELS[deployment.trigger]}
        {deployment.username ? ` · ${deployment.username}` : ''}
      </td>
      <td
        className="text-muted-foreground px-3 py-2.5 text-xs whitespace-nowrap"
        title={formatDateTime(deployment.createdAt)}
      >
        {formatRelative(deployment.createdAt)}
      </td>
      <td className="text-muted-foreground px-3 py-2.5 text-xs whitespace-nowrap">
        {duration(deployment) ?? '—'}
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
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
      </td>
    </tr>
  )
}
