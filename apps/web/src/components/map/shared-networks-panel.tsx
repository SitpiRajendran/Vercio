import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  hasRole,
  slugify,
  type EnvironmentRef,
  type ProjectView,
  type SharedNetworkView,
} from '@vercio/shared'
import { DependencyWarning, envLabel, useSharedNetworks } from '@/components/networks/dependencies'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useCurrentUser } from '@/lib/auth'
import { useProjectCompose } from '@/lib/project-compose'
import { EmptyState } from '@/pages/settings/resource-list'

/** Réseaux partagés : création, modification, suppression (onglet de la page Carte). */
export function SharedNetworksPanel() {
  const { data: user } = useCurrentUser()
  const isAdmin = user ? hasRole(user.roles, 'vercio-admin') : false
  const networks = useSharedNetworks()
  const [editing, setEditing] = useState<SharedNetworkView | 'new' | null>(null)
  const [removing, setRemoving] = useState<SharedNetworkView | null>(null)

  return (
    <>
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Un service d’un projet, joignable par les autres projets sous un nom (une base de données
          mutualisée, par exemple), sans ouvrir de port sur l’hôte.
        </p>
        {isAdmin && (
          <Button onClick={() => setEditing('new')}>
            <Plus />
            Nouveau réseau partagé
          </Button>
        )}
        {networks.isPending && <Skeleton className="h-40 w-full" />}
        {networks.error && <p className="text-destructive text-sm">{networks.error.message}</p>}
        {networks.data?.length === 0 && (
          <EmptyState icon={<Network />} title="Aucun réseau partagé">
            Exemple : le projet « PostgreSQL » expose son service <code>db</code> sous le nom{' '}
            <code>postgres-prod</code> ; les sites qui s’y abonnent s’y connectent avec{' '}
            <code>postgres-prod:5432</code>, sans publier de port sur l’hôte.
          </EmptyState>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {networks.data?.map((network) => (
            <NetworkCard
              key={network.id}
              network={network}
              isAdmin={isAdmin}
              onEdit={() => setEditing(network)}
              onRemove={() => setRemoving(network)}
            />
          ))}
        </div>
      </div>
      {editing && (
        <NetworkDialog
          network={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveDialog
          network={removing}
          networks={networks.data}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}

function EnvLink({ value }: { value: EnvironmentRef }) {
  return (
    <Link
      to="/projets/$slug"
      params={{ slug: value.projectSlug }}
      search={{ onglet: 'conteneurs', env: value.environmentSlug }}
      className="underline-offset-4 hover:underline"
    >
      {envLabel(value)}
    </Link>
  )
}

function NetworkCard({
  network,
  isAdmin,
  onEdit,
  onRemove,
}: {
  network: SharedNetworkView
  isAdmin: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4" />
          <span className="font-mono">{network.alias}</span>
        </CardTitle>
        <CardDescription>
          {network.description ?? (
            <>
              Réseau Docker <code className="text-xs">{network.dockerName}</code>
            </>
          )}
        </CardDescription>
        {isAdmin && (
          <CardAction className="flex gap-1">
            <Button variant="ghost" size="icon" aria-label="Modifier" onClick={onEdit}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Supprimer"
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Exposé par</dt>
          <dd>
            <code className="text-xs">{network.exposedBy.service}</code> de{' '}
            <EnvLink value={network.exposedBy} />
          </dd>
          <dt className="text-muted-foreground">Utilisé par</dt>
          <dd>
            {network.subscribers.length === 0 ? (
              <span className="text-muted-foreground">personne pour l’instant</span>
            ) : (
              <ul className="space-y-0.5">
                {network.subscribers.map((subscriber) => (
                  <li key={subscriber.environmentId}>
                    <EnvLink value={subscriber} />
                    <span className="text-muted-foreground text-xs">
                      {' '}
                      · {subscriber.services ? subscriber.services.join(', ') : 'tous les services'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="text-muted-foreground">Docker</dt>
          <dd>
            {network.docker === null ? (
              <span className="text-muted-foreground">Docker injoignable</span>
            ) : !network.docker.exists ? (
              <span className="text-muted-foreground">
                Pas encore créé : il le sera au prochain déploiement d’un de ces environnements.
              </span>
            ) : (
              <details>
                <summary className="cursor-pointer">
                  <Badge variant="outline">
                    <span className="bg-success size-1.5 rounded-full" aria-hidden />
                    {network.docker.containers.length} conteneur(s) attaché(s)
                  </Badge>
                </summary>
                <ul className="text-muted-foreground mt-1.5 space-y-0.5 font-mono text-xs">
                  {network.docker.containers.map((container) => (
                    <li key={container.name}>{container.name}</li>
                  ))}
                </ul>
              </details>
            )}
          </dd>
        </dl>
        <p className="text-muted-foreground text-xs">
          Depuis un service abonné : <code>{network.alias}:&lt;port du service&gt;</code> (port
          interne du conteneur, sans publication sur l’hôte). Utilisez toujours l’alias : le nom du
          service (<code>{network.exposedBy.service}</code>) répond aussi sur ce réseau et peut se
          confondre avec un service du même nom dans le projet abonné.
        </p>
      </CardContent>
    </Card>
  )
}

function NetworkDialog({
  network,
  onClose,
}: {
  network: SharedNetworkView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const [projectSlug, setProjectSlug] = useState(network?.exposedBy.projectSlug ?? '')
  const project = useQuery({
    queryKey: ['projects', projectSlug],
    queryFn: () => api.projects.get(projectSlug),
    enabled: !!projectSlug,
  })
  const [environmentId, setEnvironmentId] = useState(network?.exposedBy.environmentId ?? '')
  const [service, setService] = useState(network?.exposedBy.service ?? '')
  const [name, setName] = useState(network?.name ?? '')
  const [alias, setAlias] = useState(network?.alias ?? '')
  const [aliasEdited, setAliasEdited] = useState(!!network)
  const [description, setDescription] = useState(network?.description ?? '')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const environment = project.data?.environments.find((env) => env.id === environmentId)

  const suggest = (nextService: string, envSlug = environment?.slug) => {
    if (network || !nextService || !envSlug) return
    const suggestion = slugify(`${nextService}-${envSlug}`).slice(0, 40)
    setName(suggestion)
    if (!aliasEdited) setAlias(suggestion)
  }

  const save = useMutation({
    mutationFn: () =>
      network
        ? api.networks.update(network.id, { service, alias, description })
        : api.networks.create({ name, environmentId, service, alias, description }),
    onSuccess: async () => {
      toast.success(network ? 'Réseau modifié' : 'Réseau partagé créé')
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      onClose()
    },
    onError: (failure) =>
      setError({
        message: failure.message,
        field: failure instanceof ApiError ? failure.field : undefined,
      }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {network ? `Modifier ${network.alias}` : 'Nouveau réseau partagé'}
          </DialogTitle>
          <DialogDescription>
            Le service choisi devient joignable sous l’alias par les environnements abonnés. Pris en
            compte au prochain déploiement de chacun.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            save.mutate()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="network-project">Projet</Label>
              <Select
                value={projectSlug}
                disabled={!!network}
                onValueChange={(value) => {
                  setProjectSlug(value)
                  setEnvironmentId('')
                  setService('')
                }}
              >
                <SelectTrigger id="network-project" className="w-full">
                  <SelectValue placeholder="Choisir" />
                </SelectTrigger>
                <SelectContent>
                  {projects.data?.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-environment">Environnement</Label>
              <Select
                value={environmentId}
                disabled={!!network || !project.data}
                onValueChange={(value) => {
                  setEnvironmentId(value)
                  suggest(service, project.data?.environments.find((env) => env.id === value)?.slug)
                }}
              >
                <SelectTrigger id="network-environment" className="w-full">
                  <SelectValue placeholder="Choisir" />
                </SelectTrigger>
                <SelectContent>
                  {project.data?.environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {project.data && (
            <ServiceField
              project={project.data}
              value={service}
              onChange={(value) => {
                setService(value)
                suggest(value)
              }}
              invalid={error?.field === 'service'}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="network-name">Nom du réseau</Label>
              <Input
                id="network-name"
                className="font-mono"
                value={name}
                disabled={!!network}
                aria-invalid={error?.field === 'name'}
                onChange={(event) => {
                  setName(event.target.value)
                  if (!aliasEdited) setAlias(event.target.value)
                }}
              />
              <p className="text-muted-foreground text-xs">
                Réseau Docker <code>vercio-shared-{name || '…'}</code>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-alias">Alias (nom à utiliser)</Label>
              <Input
                id="network-alias"
                className="font-mono"
                value={alias}
                aria-invalid={error?.field === 'alias'}
                onChange={(event) => {
                  setAlias(event.target.value)
                  setAliasEdited(true)
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="network-description">Description (facultative)</Label>
            <Input
              id="network-description"
              value={description}
              placeholder="Base PostgreSQL commune aux sites"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || !environmentId || !service || !name || !alias}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              {network ? 'Enregistrer' : 'Créer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ServiceField({
  project,
  value,
  onChange,
  invalid,
}: {
  project: ProjectView
  value: string
  onChange: (value: string) => void
  invalid: boolean
}) {
  const compose = useProjectCompose(project)
  const services = compose.data?.analysis.services ?? []
  return (
    <div className="space-y-1.5">
      <Label htmlFor="network-service">Service exposé</Label>
      <Select value={value} onValueChange={onChange} disabled={!services.length}>
        <SelectTrigger id="network-service" className="w-full" aria-invalid={invalid}>
          <SelectValue
            placeholder={compose.isPending ? 'Lecture du fichier Compose…' : 'Choisir'}
          />
        </SelectTrigger>
        <SelectContent>
          {services.map((service) => (
            <SelectItem key={service.name} value={service.name} disabled={!!service.networkMode}>
              {service.name}
              {service.networkMode ? ` (network_mode: ${service.networkMode})` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {compose.error && <p className="text-destructive text-xs">{compose.error.message}</p>}
    </div>
  )
}

function RemoveDialog({
  network,
  networks,
  onClose,
}: {
  network: SharedNetworkView
  networks: SharedNetworkView[] | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.networks.remove(network.id),
    onSuccess: async ({ docker }) => {
      toast.success(
        docker === 'in_use'
          ? 'Réseau supprimé de Vercio ; le réseau Docker sera retiré des conteneurs à leur prochain déploiement'
          : 'Réseau partagé supprimé',
      )
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer le réseau {network.alias} ?</DialogTitle>
          <DialogDescription>
            Les abonnements sont supprimés. Les conteneurs restent attachés jusqu’à leur prochain
            déploiement.
          </DialogDescription>
        </DialogHeader>
        <DependencyWarning
          networks={networks?.filter((item) => item.id === network.id)}
          environmentIds={[network.exposedBy.environmentId]}
          action="la suppression"
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
