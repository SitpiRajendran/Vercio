import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GitBranch, Loader2, Lock, Pencil, Plus, Rocket, Trash2, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_RESTART_POLICY,
  RESTART_POLICIES,
  RESTART_POLICY_LABELS,
  slugify,
  type EnvironmentView,
  type ProjectView,
  type RestartPolicy,
} from '@vercio/shared'
import { DependencyWarning, useSharedNetworks } from '@/components/networks/dependencies'
import { envTarget } from '@/components/projects/project-overview-card'
import { useWorkbench } from '@/components/workbench/workbench'
import { EnvironmentNetworks } from '@/components/networks/environment-networks'
import { BranchSelect } from '@/components/projects/branch-select'
import { DeploymentStatusBadge, deployedTags } from '@/components/projects/deployment-status'
import { VersionPicker } from '@/components/projects/version-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'

interface Permissions {
  canDeploy: boolean
  isAdmin: boolean
}

export function EnvironmentsTab({ project, can }: { project: ProjectView; can: Permissions }) {
  const [editing, setEditing] = useState<EnvironmentView | 'new' | null>(null)
  const [removing, setRemoving] = useState<EnvironmentView | null>(null)
  const workbench = useWorkbench()

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {project.environments.map((env) => (
          <Card key={env.id} className="gap-4">
            <CardHeader>
              <CardTitle>{env.name}</CardTitle>
              <CardDescription className="font-mono text-xs">{env.composeProject}</CardDescription>
              <CardAction>
                {env.lastDeployment ? (
                  <Link
                    to="/projets/$slug/deploiements/$deploymentId"
                    params={{ slug: project.slug, deploymentId: env.lastDeployment.id }}
                  >
                    <DeploymentStatusBadge status={env.lastDeployment.status} />
                  </Link>
                ) : (
                  <Badge variant="outline">Jamais déployé</Badge>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {env.sources.length === 0 && (
                <p className="text-muted-foreground text-sm">Images fixes du fichier Compose.</p>
              )}
              {env.sources.map((source) => {
                const info = project.sources.find((item) => item.id === source.appSourceId)
                return (
                  <div
                    key={source.appSourceId}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="text-muted-foreground min-w-0 truncate">
                      {info?.repository}
                    </span>
                    <Badge variant="secondary" className="gap-1">
                      <GitBranch className="size-3" />
                      {source.branch}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      {source.ref}
                    </Badge>
                    {source.mode === 'locked' ? (
                      <Badge variant="outline" className="text-warning gap-1">
                        <Lock className="size-3" />
                        Verrouillé
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1">
                        <Unlock className="size-3" />
                        Mise à jour auto
                      </Badge>
                    )}
                  </div>
                )
              })}
              {env.migratingFrom && (
                <p className="text-warning text-xs">
                  Reprend le projet <code>{env.migratingFrom}</code> lancé hors de Vercio : au
                  prochain déploiement, ses conteneurs seront arrêtés puis remplacés (relancés en
                  cas d’échec).
                </p>
              )}
              {configuredDiffers(env) && (
                <p className="text-warning text-xs">
                  La version configurée diffère de celle en service : un nouveau déploiement
                  appliquera la version configurée.
                </p>
              )}
              {env.current && (
                <p className="text-muted-foreground text-xs">
                  En service :{' '}
                  <span className="text-foreground font-mono">{deployedTags(env.current)}</span>{' '}
                  depuis {formatRelative(env.current.finishedAt ?? env.current.createdAt)}
                  {env.current.username ? ` (${env.current.username})` : ''}
                </p>
              )}
              <EnvironmentNetworks project={project} environment={env} canEdit={can.isAdmin} />
              <div className="flex flex-wrap gap-2 pt-1">
                {can.canDeploy && (
                  <Button size="sm" onClick={() => workbench.openDeploy(envTarget(project, env))}>
                    <Rocket />
                    Déployer
                  </Button>
                )}
                {can.canDeploy && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(env)}>
                    <Pencil />
                    Modifier
                  </Button>
                )}
                {can.isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setRemoving(env)}
                  >
                    <Trash2 />
                    Supprimer
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {can.isAdmin && (
        <Button variant="secondary" onClick={() => setEditing('new')}>
          <Plus />
          Ajouter un environnement
        </Button>
      )}

      {editing && (
        <EnvironmentDialog
          project={project}
          environment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveEnvironmentDialog
          project={project}
          environment={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

function EnvironmentDialog({
  project,
  environment,
  onClose,
}: {
  project: ProjectView
  environment: EnvironmentView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(environment?.name ?? '')
  const [sources, setSources] = useState(
    project.sources.map((source) => {
      const current = environment?.sources.find((item) => item.appSourceId === source.id)
      return {
        source: source.id,
        branch: current?.branch ?? source.defaultBranch,
        ref: current?.ref ?? 'latest',
        mode: current?.mode ?? ('tracking' as const),
      }
    }),
  )
  const slug = environment?.slug ?? slugify(name)
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>(
    environment?.restartPolicy ?? DEFAULT_RESTART_POLICY,
  )

  const save = useMutation({
    mutationFn: () =>
      environment
        ? api.projects.updateEnvironment(project.id, environment.id, {
            name,
            sources,
            restartPolicy,
          })
        : api.projects.createEnvironment(project.id, { name, slug, sources, restartPolicy }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(`Environnement « ${name} » enregistré`)
      onClose()
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {environment ? `Modifier « ${environment.name} »` : 'Nouvel environnement'}
          </DialogTitle>
          <DialogDescription>
            Choisissez la branche puis la version : le dernier build (mise à jour automatique) ou
            l’une des 5 dernières versions construites par la CI (tags ou commits).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="env-name">Nom</Label>
            <Input id="env-name" value={name} onChange={(event) => setName(event.target.value)} />
            <p className="text-muted-foreground font-mono text-xs">
              vercio_{project.slug}_{slug || '…'}
            </p>
          </div>
          {sources.map((source, index) => {
            const info = project.sources.find((item) => item.id === source.source)!
            const update = (patch: Partial<typeof source>) =>
              setSources((current) =>
                current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
              )
            return (
              <div key={source.source} className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">{info.repository}</p>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">Branche</Label>
                  <BranchSelect
                    gitProviderId={info.gitProviderId}
                    repository={info.repository}
                    value={source.branch}
                    // Changer de branche revient à son canal latest.
                    onChange={(branch) => update({ branch, ref: 'latest', mode: 'tracking' })}
                  />
                </div>
                {environment ? (
                  <div className="space-y-1">
                    <Label className="text-muted-foreground text-xs">Version</Label>
                    <VersionPicker
                      projectId={project.id}
                      sourceId={source.source}
                      branch={source.branch}
                      value={source.ref}
                      currentRef={
                        environment.sources.find((item) => item.appSourceId === source.source)?.ref
                      }
                      // Un tag précis verrouille par défaut ; le canal latest suit les nouveaux builds.
                      onChange={(ref, kind) =>
                        update({ ref, mode: kind === 'tag' ? 'locked' : 'tracking' })
                      }
                    />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Démarre sur le dernier build de la branche ; vous pourrez choisir un tag
                    ensuite.
                  </p>
                )}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Label htmlFor={`lock-${index}`}>Verrouiller la version</Label>
                    <p className="text-muted-foreground text-xs">
                      Les webhooks sont ignorés : la version ne change que manuellement.
                    </p>
                  </div>
                  <Switch
                    id={`lock-${index}`}
                    checked={source.mode === 'locked'}
                    onCheckedChange={(locked) => update({ mode: locked ? 'locked' : 'tracking' })}
                  />
                </div>
              </div>
            )
          })}
          <div className="space-y-1.5">
            <Label htmlFor="env-restart">Redémarrage automatique des conteneurs</Label>
            <Select
              value={restartPolicy}
              onValueChange={(value) => setRestartPolicy(value as RestartPolicy)}
            >
              <SelectTrigger id="env-restart" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESTART_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {RESTART_POLICY_LABELS[policy].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {RESTART_POLICY_LABELS[restartPolicy].hint} S’applique aux services qui ne fixent pas
              leur propre <code>restart</code> dans le fichier Compose, au prochain déploiement.
            </p>
          </div>
          {save.error && <p className="text-destructive text-sm">{save.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name || !slug || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveEnvironmentDialog({
  project,
  environment,
  onClose,
}: {
  project: ProjectView
  environment: EnvironmentView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const networks = useSharedNetworks()
  const remove = useMutation({
    mutationFn: () => api.projects.removeEnvironment(project.id, environment.id),
    onSuccess: async () => {
      toast.success(`Environnement « ${environment.name} » supprimé`)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer « {environment.name} » ?</DialogTitle>
          <DialogDescription>
            Sa configuration et ses variables seront supprimées. Cette action est définitive.
          </DialogDescription>
        </DialogHeader>
        <DependencyWarning
          networks={networks.data}
          environmentIds={[environment.id]}
          action="la suppression (avec les réseaux partagés qu’il expose)"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <Loader2 className="animate-spin" />}
            Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Vrai si la branche ou la version configurée n'est pas celle du déploiement en service. */
function configuredDiffers(env: EnvironmentView): boolean {
  const current = env.current
  if (!current) return false
  return env.sources.some((source) => {
    const deployed = current.versions[source.appSourceId]
    return Boolean(deployed) && (deployed!.branch !== source.branch || deployed!.ref !== source.ref)
  })
}
