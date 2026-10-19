import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ContainerAction } from '@vercio/shared'
import {
  DependencyWarning,
  dependentsOf,
  useSharedNetworks,
} from '@/components/networks/dependencies'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { EnvTarget } from '@/components/workbench/workbench'
import { api } from '@/lib/api'

const DONE: Record<ContainerAction, string> = {
  start: 'démarré',
  restart: 'redémarré',
  stop: 'arrêté',
}

/**
 * Démarrer, redémarrer, arrêter un service ou tout l'environnement. L'arrêt demande une
 * confirmation (avec les projets qui en dépendent) ; le reste part directement.
 */
export function useContainerActions(target: EnvTarget) {
  const queryClient = useQueryClient()
  const networks = useSharedNetworks()
  /** Arrêt à confirmer : tout l'environnement (service absent) ou un service. */
  const [confirmStop, setConfirmStop] = useState<{ service?: string } | null>(null)

  const mutation = useMutation({
    mutationFn: (input: { action: ContainerAction; service?: string }) =>
      api.containers.action(target.projectId, target.envId, input),
    onSuccess: (list, input) => {
      queryClient.setQueryData(['containers', target.envId], list)
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      void queryClient.invalidateQueries({ queryKey: ['events'] })
      toast.success(
        `${input.service ?? `${target.projectName} (${target.envName})`} ${DONE[input.action]}`,
      )
      setConfirmStop(null)
    },
    onError: (error) => toast.error(error.message),
  })

  const run = (action: ContainerAction, service?: string) => {
    if (action === 'stop') setConfirmStop({ service })
    else mutation.mutate({ action, service })
  }
  const pending = mutation.isPending ? mutation.variables : null
  const dependents = dependentsOf(networks.data, [target.envId], confirmStop?.service)

  const dialog = (
    <Dialog open={!!confirmStop} onOpenChange={(open) => !open && setConfirmStop(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {confirmStop?.service
              ? `Arrêter ${confirmStop.service} ?`
              : `Arrêter ${target.projectName} ?`}
          </DialogTitle>
          <DialogDescription>
            {confirmStop?.service
              ? 'Le service ne répondra plus jusqu’à son prochain démarrage ou déploiement.'
              : `Tous les conteneurs de ${target.envName} s’arrêtent : le site ne répondra plus jusqu’au prochain démarrage ou déploiement.`}{' '}
            Les volumes et les données sont conservés.
          </DialogDescription>
        </DialogHeader>
        {dependents.length > 0 && (
          <DependencyWarning
            networks={networks.data}
            environmentIds={[target.envId]}
            service={confirmStop?.service}
            action="l’arrêt"
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmStop(null)}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ action: 'stop', service: confirmStop?.service })}
          >
            {mutation.isPending && <Loader2 className="animate-spin" />}
            Arrêter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { run, pending, busy: mutation.isPending, dialog }
}
