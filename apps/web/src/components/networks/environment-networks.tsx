import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2, Network } from 'lucide-react'
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
import { envLabel, useSharedNetworks } from './dependencies'

/** Réseaux partagés d'un environnement : ce qu'il expose, ce qu'il rejoint. */
export function EnvironmentNetworks({
  project,
  environment,
  canEdit,
}: {
  project: ProjectView
  environment: EnvironmentView
  canEdit: boolean
}) {
  const networks = useSharedNetworks()
  const [editing, setEditing] = useState(false)
  const exposed = (networks.data ?? []).filter(
    (network) => network.exposedBy.environmentId === environment.id,
  )
  const joined = (networks.data ?? []).filter((network) =>
    network.subscribers.some((subscriber) => subscriber.environmentId === environment.id),
  )
  if (!networks.data || (!exposed.length && !joined.length && !canEdit)) return null

  return (
    <div className="space-y-1.5 text-xs">
      {exposed.map((network) => (
        <p key={network.id} className="flex flex-wrap items-center gap-1.5">
          <Network className="text-muted-foreground size-3.5" />
          Expose <code>{network.exposedBy.service}</code> sous <code>{network.alias}</code>
          <span className="text-muted-foreground">
            ·{' '}
            {network.subscribers.length
              ? `utilisé par ${network.subscribers.map(envLabel).join(', ')}`
              : 'aucun abonné'}
          </span>
        </p>
      ))}
      {joined.map((network) => {
        const services = network.subscribers.find(
          (subscriber) => subscriber.environmentId === environment.id,
        )?.services
        return (
          <p key={network.id} className="flex flex-wrap items-center gap-1.5">
            <Network className="text-muted-foreground size-3.5" />
            Joint <code>{network.alias}</code>
            <span className="text-muted-foreground">
              ({envLabel(network.exposedBy)}) depuis{' '}
              {services ? services.join(', ') : 'tous les services'}
            </span>
          </p>
        )
      })}
      {canEdit && (
        <Button
          variant="link"
          size="sm"
          className="h-auto gap-1 p-0 text-xs"
          onClick={() => setEditing(true)}
        >
          <Network className="size-3.5" />
          {joined.length ? 'Modifier les réseaux partagés' : 'Rejoindre un réseau partagé'}
        </Button>
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
          <DialogTitle>Réseaux partagés de « {environment.name} »</DialogTitle>
          <DialogDescription>
            Les services choisis rejoignent le réseau et atteignent le service exposé par son alias
            (par exemple <code>postgres-prod:5432</code>). Appliqué au prochain déploiement.
          </DialogDescription>
        </DialogHeader>
        {available.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Aucun réseau partagé disponible.{' '}
            <Link to="/reseaux" className="underline">
              Créer un réseau partagé
            </Link>
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
