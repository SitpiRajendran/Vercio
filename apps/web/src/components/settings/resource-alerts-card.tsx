import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ResourceAlertSettings } from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'

const KEY = ['settings', 'resource-alerts']

const FIELDS: {
  key: Exclude<keyof ResourceAlertSettings, 'enabled'>
  label: string
  unit: string
  hint: string
}[] = [
  {
    key: 'cpuPercent',
    label: 'Seuil processeur',
    unit: '% d’un cœur',
    hint: '100 = un cœur plein, 200 = deux cœurs.',
  },
  {
    key: 'memoryPercent',
    label: 'Seuil mémoire',
    unit: '% de la limite',
    hint: 'Limite du conteneur (mem_limit), sinon mémoire de l’hôte.',
  },
  {
    key: 'sustainMinutes',
    label: 'Durée d’un épisode',
    unit: 'min',
    hint: 'Au-dessus du seuil pendant ce temps : un épisode commence (et finit après autant en dessous).',
  },
  {
    key: 'frequentEpisodes',
    label: 'Alerter à partir de',
    unit: 'épisodes en 24 h',
    hint: 'Les épisodes isolés restent seulement dans l’activité.',
  },
  {
    key: 'longMinutes',
    label: 'Ou si un épisode dure',
    unit: 'min',
    hint: 'Une saturation continue alerte sans attendre la répétition.',
  },
]

/** Seuils de la surveillance du processeur et de la mémoire des services. */
export function ResourceAlertsCard() {
  const settings = useQuery({ queryKey: KEY, queryFn: api.resourceAlerts.get })
  if (!settings.data) return <Skeleton className="h-48 w-full" />
  return <Form key={JSON.stringify(settings.data)} initial={settings.data} />
}

function Form({ initial }: { initial: ResourceAlertSettings }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(initial)
  const save = useMutation({
    mutationFn: () => api.resourceAlerts.save(value),
    onSuccess: (saved) => {
      queryClient.setQueryData(KEY, saved)
      toast.success('Surveillance du processeur et de la mémoire enregistrée')
    },
    onError: (error) => toast.error(error.message),
  })
  const changed = JSON.stringify(value) !== JSON.stringify(initial)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 font-semibold">
            <Gauge className="size-4" />
            Processeur et mémoire
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Un service saturé est noté dans l’activité et signalé sur l’accueil ; la notification
            (case « CPU ou mémoire saturés » des canaux) ne part que si ça se répète ou dure, une
            fois par 24 h et par service.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="resource-enabled"
            checked={value.enabled}
            onCheckedChange={(enabled) => setValue({ ...value, enabled })}
          />
          <Label htmlFor="resource-enabled">Surveillance active</Label>
        </div>
      </div>
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`resource-${field.key}`}>{field.label}</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`resource-${field.key}`}
                type="number"
                min={1}
                className="w-24"
                disabled={!value.enabled}
                value={value[field.key]}
                onChange={(event) =>
                  setValue({ ...value, [field.key]: Number(event.target.value) })
                }
              />
              <span className="text-muted-foreground text-sm">{field.unit}</span>
            </div>
            <p className="text-muted-foreground text-xs">{field.hint}</p>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={!changed || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Enregistrer
        </Button>
      </div>
    </section>
  )
}
