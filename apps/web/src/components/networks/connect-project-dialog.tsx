import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import {
  LINK_KINDS,
  linkDatabaseName,
  linkUrl,
  slugify,
  type EnvironmentView,
  type LinkTarget,
  type ProjectView,
} from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { defaultPort } from '@/lib/default-ports'
import { useProjectCompose } from '@/lib/project-compose'
import { cn } from '@/lib/utils'

/** Services qui parlent habituellement à une base ou une API (le front passe par eux). */
const BACKEND = /^(back|backend|api|server|app|worker|web-?api|core)([-_].*)?$/i

const targetKey = (target: LinkTarget) => `${target.environmentId}/${target.service}`

/**
 * « Connecter un service » : en une fenêtre, un service d'un autre projet (base de données,
 * Redis, API…) devient joignable depuis cet environnement, sur un réseau réservé à cette liaison.
 * Pour une base : base et utilisateur dédiés créés, variable de connexion enregistrée,
 * redéploiement lancé.
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
  const targets = useQuery({
    queryKey: ['link-targets', environment.id],
    queryFn: () => api.networks.linkTargets(project.id, environment.id),
  })
  const own = useProjectCompose(project)
  const ownServices = useMemo(
    () =>
      (own.data?.analysis.services ?? [])
        .filter((item) => !item.networkMode)
        .map((item) => item.name),
    [own.data],
  )

  const [key, setKey] = useState('')
  const target = targets.data?.find((item) => targetKey(item) === key) ?? null
  const kind = target ? LINK_KINDS[target.kind] : null
  const [selected, setSelected] = useState<string[] | null>(null)
  const [alias, setAlias] = useState('')
  const [access, setAccess] = useState<'dedicated' | 'none'>('dedicated')
  const [database, setDatabase] = useState(linkDatabaseName(project.slug))
  const [saveVariable, setSaveVariable] = useState(true)
  const [variable, setVariable] = useState('')
  const [port, setPort] = useState('')
  const [redeploy, setRedeploy] = useState(true)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  // Services reliés par défaut : ceux qui parlent à une base ou une API, sinon tous.
  const defaults = useMemo(() => {
    const backends = ownServices.filter((name) => BACKEND.test(name))
    return backends.length && backends.length < ownServices.length ? backends : ownServices
  }, [ownServices])
  const services = selected ?? defaults

  function choose(next: string) {
    const item = targets.data?.find((candidate) => targetKey(candidate) === next)
    setKey(next)
    setError(null)
    if (!item) return
    const name = ownServices.includes(item.service)
      ? slugify(`${item.projectSlug}-${item.service}`).slice(0, 40)
      : slugify(item.service).slice(0, 40)
    setAlias(item.linkedAs ?? name)
    const meta = LINK_KINDS[item.kind]
    setAccess(meta.dedicated && item.running ? 'dedicated' : 'none')
    setVariable(
      item.kind === 'service'
        ? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`
        : meta.variable,
    )
    setPort(String(item.port ?? defaultPort(item.image) ?? ''))
  }

  const effectivePort = kind?.port ?? (Number(port) || null)
  const name = target?.linkedAs ?? alias
  const preview =
    target &&
    linkUrl(
      target.kind,
      name || '…',
      effectivePort,
      kind?.dedicated && access === 'dedicated'
        ? { user: database, password: 'MOT_DE_PASSE', database }
        : null,
    ).replace('MOT_DE_PASSE', '••••••')

  const connect = useMutation({
    mutationFn: () =>
      api.networks.link(project.id, environment.id, {
        targetEnvironmentId: target!.environmentId,
        service: target!.service,
        alias: name,
        services: services.length === ownServices.length ? null : services,
        access: kind?.dedicated ? access : 'none',
        database: kind?.dedicated && access === 'dedicated' ? database : undefined,
        variable: saveVariable ? variable : null,
        port: target!.kind === 'service' ? effectivePort : null,
        redeploy: saveVariable && redeploy,
      }),
    onSuccess: async (result) => {
      await Promise.all(
        [['networks'], ['overview'], ['link-targets'], ['variables'], ['projects']].map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      )
      const parts = [`${project.name} joint ${target!.service} sous le nom ${result.network.alias}`]
      if (result.database) parts.push(`base « ${result.database.name} » prête`)
      if (result.variable) parts.push(`variable ${result.variable} enregistrée`)
      if (result.deploymentId) parts.push('redéploiement lancé')
      if (result.applied || result.deploymentId) toast.success(parts.join(' · '))
      else toast.warning(`${parts.join(' · ')}. ${result.detail ?? ''}`)
      onClose()
    },
    onError: (failure) =>
      setError({
        message: failure.message,
        field: failure instanceof ApiError ? failure.field : undefined,
      }),
  })

  const groups = useMemo(() => {
    const map = new Map<string, LinkTarget[]>()
    for (const item of targets.data ?? []) {
      const label =
        item.environmentSlug === 'prod' || !item.environmentName
          ? item.projectName
          : `${item.projectName} · ${item.environmentName}`
      map.set(label, [...(map.get(label) ?? []), item])
    }
    return [...map.entries()]
  }, [targets.data])

  const invalid =
    !target ||
    !name ||
    services.length === 0 ||
    (saveVariable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) ||
    (kind?.dedicated && access === 'dedicated' && !/^[a-z][a-z0-9_]{0,31}$/.test(database)) ||
    (target.kind === 'service' && !effectivePort && saveVariable)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connecter un service</DialogTitle>
          <DialogDescription>
            Une base de données, un Redis ou une API d’un autre projet devient joignable depuis{' '}
            {project.name}. Chaque liaison a son propre réseau : les autres projets reliés au même
            service ne voient pas {project.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            connect.mutate()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="link-target">Service à joindre</Label>
            <Select value={key} onValueChange={choose}>
              <SelectTrigger
                id="link-target"
                className="w-full"
                aria-invalid={error?.field === 'service' || error?.field === 'targetEnvironmentId'}
              >
                <SelectValue
                  placeholder={
                    targets.isPending
                      ? 'Lecture des projets…'
                      : groups.length
                        ? 'Choisir'
                        : 'Aucun autre projet déployé'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {groups.map(([label, items]) => (
                  <SelectGroup key={label}>
                    <SelectLabel>{label}</SelectLabel>
                    {items.map((item) => (
                      <SelectItem key={targetKey(item)} value={targetKey(item)}>
                        {item.service}
                        <span className="text-muted-foreground">
                          {' · '}
                          {item.kind === 'service'
                            ? (item.image ?? 'service')
                            : LINK_KINDS[item.kind].label}
                          {!item.running && ' · arrêté'}
                          {item.linkedAs && ` · déjà relié (${item.linkedAs})`}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          {target && (
            <>
              {ownServices.length > 1 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Depuis</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {ownServices.map((service) => (
                      <label key={service} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={services.includes(service)}
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked === true
                                ? [...services, service]
                                : services.filter((item) => item !== service),
                            )
                          }
                        />
                        {service}
                      </label>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Seuls ces services de {project.name} pourront joindre {target.service}.
                  </p>
                </fieldset>
              )}

              <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="link-alias">Nom dans {project.name}</Label>
                  <Input
                    id="link-alias"
                    className="font-mono"
                    value={name}
                    disabled={!!target.linkedAs}
                    aria-invalid={error?.field === 'alias'}
                    onChange={(event) => setAlias(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    {target.linkedAs
                      ? 'Déjà relié sous ce nom.'
                      : 'Minuscules, chiffres et tirets.'}
                  </p>
                </div>
                {target.kind === 'service' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="link-port">Port</Label>
                    <Input
                      id="link-port"
                      inputMode="numeric"
                      className="font-mono"
                      placeholder="80"
                      value={port}
                      onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
                    />
                  </div>
                )}
              </div>

              {kind?.dedicated && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Accès à la base</legend>
                  <Choice
                    checked={access === 'dedicated'}
                    disabled={!target.running}
                    onSelect={() => setAccess('dedicated')}
                    title={`Créer une base et un utilisateur pour ${project.name}`}
                    hint={
                      target.running
                        ? 'Mot de passe aléatoire, créé par Vercio dans la base. Recommandé : chaque application n’accède qu’à ses données.'
                        : `${target.service} est arrêté : démarrez-le pour créer la base.`
                    }
                  >
                    {access === 'dedicated' && (
                      <Input
                        aria-label="Nom de la base et de l’utilisateur"
                        className="mt-2 h-8 font-mono"
                        value={database}
                        aria-invalid={
                          error?.field === 'access' || !/^[a-z][a-z0-9_]{0,31}$/.test(database)
                        }
                        onChange={(event) => setDatabase(event.target.value)}
                      />
                    )}
                  </Choice>
                  <Choice
                    checked={access === 'none'}
                    onSelect={() => setAccess('none')}
                    title="Adresse seulement"
                    hint="Vous ajouterez l’utilisateur et le mot de passe vous-même dans les variables."
                  />
                </fieldset>
              )}

              <div className="space-y-2 rounded-lg border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={saveVariable}
                    onCheckedChange={(checked) => setSaveVariable(checked === true)}
                  />
                  Enregistrer la variable de connexion
                </label>
                {saveVariable && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="Nom de la variable"
                        className="h-8 w-48 font-mono"
                        value={variable}
                        onChange={(event) => setVariable(event.target.value)}
                      />
                      <span className="text-muted-foreground">=</span>
                      <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">
                        {preview}
                      </code>
                    </div>
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <ShieldCheck className="size-3.5" />
                      Enregistrée comme secrète dans les variables de {environment.name}.
                    </p>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={redeploy}
                        onCheckedChange={(checked) => setRedeploy(checked === true)}
                      />
                      Redéployer {project.name} ensuite (la variable n’est lue qu’au démarrage)
                    </label>
                  </>
                )}
              </div>

              <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                {services.join(', ') || '—'} <ArrowRight className="size-3" />
                <span className="text-foreground font-mono">
                  {name}
                  {effectivePort ? `:${effectivePort}` : ''}
                </span>
                <ArrowRight className="size-3" />
                {target.service} de {target.projectName}
                <Badge variant="outline" className="ml-1">
                  réseau réservé
                </Badge>
              </p>
            </>
          )}

          {error && <p className="text-destructive text-sm">{error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={connect.isPending || !!invalid}>
              {connect.isPending && <Loader2 className="animate-spin" />}
              Connecter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Choice({
  checked,
  disabled = false,
  onSelect,
  title,
  hint,
  children,
}: {
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  title: string
  hint: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-sm',
        checked && 'border-brand bg-brand/5',
        disabled && 'opacity-60',
      )}
    >
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="radio"
          className="accent-primary mt-1"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
        />
        <span>
          <span className="block font-medium">{title}</span>
          <span className="text-muted-foreground block text-xs">{hint}</span>
        </span>
      </label>
      {children && <div className="pl-6">{children}</div>}
    </div>
  )
}
