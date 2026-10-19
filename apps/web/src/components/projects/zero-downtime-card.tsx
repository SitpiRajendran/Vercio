import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectView } from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useProjectCompose } from '@/lib/project-compose'

/**
 * Services mis à jour sans coupure : la nouvelle version démarre à côté de l'ancienne, qui ne
 * s'arrête qu'une fois la nouvelle prête. Leurs ports passent par un petit relais.
 */
export function ZeroDowntimeCard({ project, canEdit }: { project: ProjectView; canEdit: boolean }) {
  const compose = useProjectCompose(project)
  if (compose.isPending) return <Skeleton className="h-32 w-full" />
  const services = compose.data?.analysis.error ? [] : (compose.data?.analysis.services ?? [])
  return (
    <Form
      key={`${project.updatedAt}-${project.zeroDowntimeServices.join(',')}`}
      project={project}
      services={services}
      canEdit={canEdit}
    />
  )
}

function Form({
  project,
  services,
  canEdit,
}: {
  project: ProjectView
  services: NonNullable<ReturnType<typeof useProjectCompose>['data']>['analysis']['services']
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState(project.zeroDowntimeServices)
  const save = useMutation({
    mutationFn: () => api.projects.zeroDowntime(project.id, selected),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      toast.success('Appliqué au prochain déploiement')
    },
    onError: (error) => toast.error(error.message),
  })
  const changed = [...selected].sort().join() !== [...project.zeroDowntimeServices].sort().join()

  return (
    <div className="space-y-3">
      <div className="divide-y rounded-lg border">
        {services.map((service) => {
          const on = selected.includes(service.name)
          const info = service.zeroDowntime
          return (
            <div key={service.name} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor={`zero-${service.name}`} className="font-medium">
                  {service.name}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {!info.eligible
                    ? `Impossible : ${info.reason}.`
                    : service.ports.length
                      ? `Ports ${service.ports.join(', ')} repris par un relais, qui reste en place pendant la bascule.`
                      : 'Joint par les autres services par son nom : rien à relayer.'}
                  {info.eligible && !service.hasHealthcheck && on && (
                    <span className="text-warning block">
                      Sans healthcheck, la nouvelle version est jugée prête 3 s après son démarrage
                      : ajoutez un healthcheck pour une bascule fiable.
                    </span>
                  )}
                </p>
                {info.warning && on && (
                  <p className="text-warning mt-1 flex items-start gap-1 text-xs">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                    {info.warning}
                  </p>
                )}
              </div>
              <Switch
                id={`zero-${service.name}`}
                checked={on}
                disabled={!canEdit || (!info.eligible && !on)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...current, service.name]
                      : current.filter((item) => item !== service.name),
                  )
                }
              />
            </div>
          )
        })}
        {services.length === 0 && (
          <p className="text-muted-foreground p-3 text-sm">Fichier Compose illisible.</p>
        )}
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!changed || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer
          </Button>
        </div>
      )}
    </div>
  )
}
