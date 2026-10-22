import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Link2, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvironmentView, ProjectView, SharedNetworkView } from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useProjectCompose } from '@/lib/project-compose'
import { ConnectProjectDialog } from './connect-project-dialog'
import { envLabel, useSharedNetworks } from './dependencies'

/**
 * Liens d'un environnement avec d'autres projets : les services qu'il joint (« connecté à ») et
 * ceux qu'il partage (« utilisé par »). Une liaison se crée depuis le projet qui consomme.
 */
export function EnvironmentNetworks({
  project,
  environment,
  canEdit,
  actionsOnly = false,
}: {
  project: ProjectView
  environment: EnvironmentView
  canEdit: boolean
  /** Boutons seuls (la carte affiche déjà les liaisons). */
  actionsOnly?: boolean
}) {
  const networks = useSharedNetworks()
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const exposed = (networks.data ?? []).filter(
    (network) => network.exposedBy.environmentId === environment.id,
  )
  const joined = (networks.data ?? []).filter((network) =>
    network.subscribers.some((subscriber) => subscriber.environmentId === environment.id),
  )
  if (!networks.data || (!exposed.length && !joined.length && !canEdit)) return null

  return (
    <div className="space-y-2 text-sm">
      {!actionsOnly &&
        joined.map((network) => {
          const services = network.subscribers.find(
            (subscriber) => subscriber.environmentId === environment.id,
          )?.services
          return (
            <div key={network.id} className="flex items-start gap-2">
              <Link2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p>
                  Connecté à <span className="font-medium">{network.exposedBy.service}</span> de{' '}
                  <Link
                    to="/projets/$slug"
                    params={{ slug: network.exposedBy.projectSlug }}
                    className="font-medium hover:underline"
                  >
                    {network.exposedBy.projectName}
                  </Link>
                </p>
                <p className="text-muted-foreground text-xs">
                  Adresse : <code className="text-foreground">{network.alias}</code>
                  {services ? ` · depuis ${services.join(', ')}` : ''}
                </p>
              </div>
            </div>
          )
        })}
      {!actionsOnly &&
        exposed.map((network) => (
          <div key={network.id} className="flex items-start gap-2">
            <Share2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p>
                <span className="font-medium">{network.exposedBy.service}</span> partagé sous{' '}
                <code>{network.alias}</code>
              </p>
              <p className="text-muted-foreground text-xs">
                {network.subscribers.length
                  ? `Utilisé par ${network.subscribers.map(envLabel).join(', ')}`
                  : 'Aucun projet connecté'}
              </p>
            </div>
          </div>
        ))}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          <Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
            <Link2 />
            Connecter à un autre projet
          </Button>
          {joined.length > 0 && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setEditing(true)}
            >
              Modifier les liaisons
            </Button>
          )}
        </div>
      )}
      {canEdit && !actionsOnly && !exposed.length && !joined.length && (
        <p className="text-muted-foreground text-xs">
          Pour joindre la base de données d’un autre projet, par exemple.
        </p>
      )}
      {connecting && (
        <ConnectProjectDialog
          project={project}
          environment={environment}
          onClose={() => setConnecting(false)}
        />
      )}
      {editing && (
        <SubscriptionsDialog
          project={project}
          environment={environment}
          networks={networks.data}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

interface Choice {
  /** null : tous les services. */
  services: string[] | null
}

function SubscriptionsDialog({
  project,
  environment,
  networks,
  onClose,
}: {
  project: ProjectView
  environment: EnvironmentView
  networks: SharedNetworkView[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const compose = useProjectCompose(project)
  const services =
    compose.data?.analysis.services
      .filter((service) => !service.networkMode)
      .map((service) => service.name) ?? []
  const available = networks.filter((network) => network.exposedBy.environmentId !== environment.id)
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      networks.flatMap((network) => {
        const subscriber = network.subscribers.find((item) => item.environmentId === environment.id)
        return subscriber ? [[network.id, { services: subscriber.services }]] : []
      }),
    ),
  )
  const save = useMutation({
    mutationFn: () =>
      api.networks.subscribe(project.id, environment.id, {
        subscriptions: Object.entries(choices).map(([networkId, choice]) => ({
          networkId,
          services: choice.services,
        })),
      }),
    onSuccess: async () => {
      toast.success('Réseaux enregistrés : appliqués au prochain déploiement')
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  const invalid = Object.values(choices).some((choice) => choice.services?.length === 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Liaisons de « {environment.name} »</DialogTitle>
          <DialogDescription>
            Les services choisis rejoignent le réseau et atteignent le service exposé par son alias
            (par exemple <code>postgres-prod:5432</code>). Appliqué au prochain déploiement.
          </DialogDescription>
        </DialogHeader>
        {available.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Aucune liaison : utilisez « Connecter à un autre projet ».
          </p>
        ) : (
          <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
            {available.map((network) => {
              const choice = choices[network.id]
              return (
                <li key={network.id} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={`network-${network.id}`}
                      className="mt-0.5"
                      checked={!!choice}
                      onCheckedChange={(checked) =>
                        setChoices((current) => {
                          const next = { ...current }
                          if (checked === true) next[network.id] = { services: null }
                          else delete next[network.id]
                          return next
                        })
                      }
                    />
                    <Label htmlFor={`network-${network.id}`} className="block font-normal">
                      <span className="font-medium">{network.alias}</span>
                      <span className="text-muted-foreground block text-xs">
                        {network.exposedBy.service} de {envLabel(network.exposedBy)}
                        {network.description ? ` · ${network.description}` : ''}
                      </span>
                    </Label>
                  </div>
                  {choice && (
                    <div className="space-y-1.5 pl-6 text-xs">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`network-${network.id}-all`}
                          checked={choice.services === null}
                          onCheckedChange={(checked) =>
                            setChoices((current) => ({
                              ...current,
                              [network.id]: { services: checked === true ? null : [] },
                            }))
                          }
                        />
                        <Label htmlFor={`network-${network.id}-all`} className="font-normal">
                          Tous les services
                        </Label>
                      </div>
                      {choice.services !== null && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {compose.isPending && <Loader2 className="size-3.5 animate-spin" />}
                          {services.map((service) => (
                            <div key={service} className="flex items-center gap-1.5">
                              <Checkbox
                                id={`network-${network.id}-${service}`}
                                checked={choice.services!.includes(service)}
                                onCheckedChange={(checked) =>
                                  setChoices((current) => {
                                    const list = current[network.id]?.services ?? []
                                    return {
                                      ...current,
                                      [network.id]: {
                                        services:
                                          checked === true
                                            ? [...list, service]
                                            : list.filter((item) => item !== service),
                                      },
                                    }
                                  })
                                }
                              />
                              <Label
                                htmlFor={`network-${network.id}-${service}`}
                                className="font-mono font-normal"
                              >
                                {service}
                              </Label>
                            </div>
                          ))}
                          {choice.services.length === 0 && (
                            <p className="text-destructive w-full">
                              Choisissez au moins un service.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || invalid}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
