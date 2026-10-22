import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { slugify, type EnvironmentView, type ProjectView } from '@vercio/shared'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { defaultPort } from '@/lib/default-ports'
import { useProjectCompose } from '@/lib/project-compose'
import { useSharedNetworks } from './dependencies'

/**
 * « Connecter à un autre projet » : un service d'un autre projet (une base de données, par
 * exemple) devient joignable par son nom depuis cet environnement. Vercio crée le réseau partagé
 * au besoin et branche tout de suite les conteneurs en marche.
 */
export function ConnectProjectDialog({
  project,
  environment,
  onClose,
}: {
  project: ProjectView
  environment: EnvironmentView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const networks = useSharedNetworks()
  const [targetSlug, setTargetSlug] = useState('')
  const target = useQuery({
    queryKey: ['projects', targetSlug],
    queryFn: () => api.projects.get(targetSlug),
    enabled: !!targetSlug,
  })
  const [targetEnvId, setTargetEnvId] = useState('')
  const [service, setService] = useState('')
  const [serviceImage, setServiceImage] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const [aliasEdited, setAliasEdited] = useState(false)
  const own = useProjectCompose(project)
  const ownServices = own.data?.analysis.services.map((item) => item.name) ?? []
  const [selected, setSelected] = useState<string[] | null>(null)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  const envId = targetEnvId || target.data?.environments[0]?.id || ''
  const targetEnv = target.data?.environments.find((env) => env.id === envId)
  // Service déjà partagé : son nom est imposé.
  const existing = networks.data?.find(
    (network) => network.exposedBy.environmentId === envId && network.exposedBy.service === service,
  )
  const name = existing?.alias ?? alias
  const suggest = (nextService: string) => {
    if (aliasEdited || !target.data || !nextService) return
    // Le nom du projet (`skillin-db`) ; le service en plus s'il est déjà pris.
    const base = slugify(target.data.slug).slice(0, 40)
    const taken = networks.data?.some((network) => network.alias === base)
    setAlias(taken ? slugify(`${base}-${nextService}`).slice(0, 40) : base)
  }

  const connect = useMutation({
    mutationFn: () =>
      api.networks.link(project.id, environment.id, {
        targetEnvironmentId: envId,
        service,
        alias: name,
        services: selected,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      await queryClient.invalidateQueries({ queryKey: ['overview'] })
      if (result.applied) toast.success(`Connecté : vos services joignent ${result.network.alias}`)
      else toast.warning(result.detail ?? 'Liaison enregistrée, appliquée au prochain déploiement')
      onClose()
    },
    onError: (failure) =>
      setError({
        message: failure.message,
        field: failure instanceof ApiError ? failure.field : undefined,
      }),
  })

  const others = projects.data?.filter((item) => item.id !== project.id) ?? []
  const port = defaultPort(serviceImage ?? service)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connecter à un autre projet</DialogTitle>
          <DialogDescription>
            Un service d’un autre projet (sa base de données, par exemple) devient joignable par un
            nom depuis {project.name}, sans ouvrir de port sur le serveur.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            connect.mutate()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="link-project">Projet</Label>
              <Select
                value={targetSlug}
                onValueChange={(value) => {
                  setTargetSlug(value)
                  setTargetEnvId('')
                  setService('')
                  setAliasEdited(false)
                  setAlias('')
                }}
              >
                <SelectTrigger
                  id="link-project"
                  className="w-full"
                  aria-invalid={error?.field === 'targetEnvironmentId'}
                >
                  <SelectValue placeholder={others.length ? 'Choisir' : 'Aucun autre projet'} />
                </SelectTrigger>
                <SelectContent>
                  {others.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {target.data && (
              <ServiceSelect
                project={target.data}
                value={service}
                invalid={error?.field === 'service'}
                onChange={(value, image) => {
                  setService(value)
                  setServiceImage(image)
                  suggest(value)
                }}
              />
            )}
          </div>
          {target.data && target.data.environments.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="link-environment">Environnement de {target.data.name}</Label>
              <Select value={envId} onValueChange={setTargetEnvId}>
                <SelectTrigger id="link-environment" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {target.data.environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {service && (
            <div className="space-y-1.5">
              <Label htmlFor="link-alias">Nom à utiliser dans {project.name}</Label>
              <Input
                id="link-alias"
                className="font-mono"
                value={name}
                disabled={!!existing}
                aria-invalid={error?.field === 'alias'}
                onChange={(event) => {
                  setAlias(event.target.value)
                  setAliasEdited(true)
                }}
              />
              <p className="text-muted-foreground text-xs">
                {existing
                  ? `${service} est déjà partagé sous ce nom.`
                  : 'Minuscules, chiffres et tirets.'}
              </p>
            </div>
          )}
          {ownServices.length > 1 && service && (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Services de {project.name} reliés</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {ownServices.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={!selected || selected.includes(name)}
                      onCheckedChange={(checked) => {
                        const current = selected ?? ownServices
                        const next =
                          checked === true
                            ? [...current, name]
                            : current.filter((item) => item !== name)
                        setSelected(next.length === ownServices.length ? null : next)
                      }}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {service && name && targetEnv && (
            <div className="bg-muted/50 space-y-1 rounded-md p-3 text-sm">
              <p className="flex flex-wrap items-center gap-1.5">
                {project.name} <ArrowRight className="size-3.5" />
                <span className="font-medium">
                  {service} de {target.data!.name}
                </span>
              </p>
              <p className="text-muted-foreground text-xs">
                Adresse à utiliser dans {project.name} :{' '}
                <code className="text-foreground">
                  {name}
                  {port ? `:${port}` : ''}
                </code>
                {port === 5432 && (
                  <>
                    {' '}
                    (par exemple <code>postgresql://utilisateur:mot-de-passe@{name}:5432/base</code>
                    )
                  </>
                )}
              </p>
            </div>
          )}
          {error && <p className="text-destructive text-sm">{error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={connect.isPending || !envId || !service || !name || selected?.length === 0}
            >
              {connect.isPending && <Loader2 className="animate-spin" />}
              Connecter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ServiceSelect({
  project,
  value,
  onChange,
  invalid,
}: {
  project: ProjectView
  value: string
  onChange: (value: string, image: string | null) => void
  invalid: boolean
}) {
  const compose = useProjectCompose(project)
  const services = (compose.data?.analysis.services ?? []).filter((item) => !item.networkMode)
  const choose = (name: string) =>
    onChange(name, services.find((item) => item.name === name)?.image ?? null)
  // Un seul service : choisi d'office.
  useEffect(() => {
    if (services.length === 1 && !value) choose(services[0]!.name)
  })
  return (
    <div className="space-y-1.5">
      <Label htmlFor="link-service">Service</Label>
      <Select value={value} onValueChange={choose} disabled={!services.length}>
        <SelectTrigger id="link-service" className="w-full" aria-invalid={invalid}>
          <SelectValue placeholder={compose.isPending ? 'Lecture…' : 'Choisir'} />
        </SelectTrigger>
        <SelectContent>
          {services.map((item) => (
            <SelectItem key={item.name} value={item.name}>
              {item.name}
              {item.image ? ` (${item.image})` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
