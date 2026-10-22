import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ExternalLink, Globe, Loader2, Plus, Rocket, X } from 'lucide-react'
import { toast } from 'sonner'
import type {
  EnvironmentView,
  OverviewEnvironment,
  ProjectView,
  PublishedPortRule,
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useWorkbench, type EnvTarget } from '@/components/workbench/workbench'
import { api, ApiError } from '@/lib/api'
import { defaultPort } from '@/lib/default-ports'
import { useProjectCompose } from '@/lib/project-compose'

/** Ports des bases de données courantes : pas de page d'attente HTTP par défaut. */
const DATABASE_PORTS = new Set([5432, 3306, 27017, 6379, 5672, 9200])

const withPage = (rule: PublishedPortRule) => rule.page && rule.protocol === 'tcp'

/** Nom d'hôte d'une adresse saisie par l'utilisateur (l'adresse entière si elle est mal formée). */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const portLabel = (port: { published: number; protocol: string }) =>
  `${port.published}${port.protocol === 'udp' ? '/udp' : ''}`

/**
 * Ports ouverts vers l'extérieur : ceux ajoutés depuis Vercio (modifiables) et ceux écrits dans
 * le fichier Compose (lecture seule). Une ouverture s'applique au prochain déploiement.
 */
export function EnvironmentPorts({
  project,
  environment,
  live,
  target,
}: {
  project: ProjectView
  environment: EnvironmentView
  live: OverviewEnvironment | undefined
  target: EnvTarget
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const rules = environment.publishedPorts
  const published = (live?.containers ?? []).flatMap((container) =>
    container.published
      .filter((port) => port.ip === null || port.ip === '0.0.0.0' || port.ip === '::')
      .map((port) => ({ ...port, service: container.relayFor ?? container.service })),
  )
  const isApplied = (rule: PublishedPortRule) =>
    published.some(
      (port) =>
        port.hostPort === rule.published &&
        port.containerPort === rule.target &&
        port.protocol === rule.protocol,
    )
  // Ports du fichier Compose : ouverts, mais pas par une règle de Vercio.
  const fromCompose = [
    ...new Map(
      published
        .filter(
          (port) =>
            !rules.some(
              (rule) => rule.published === port.hostPort && rule.protocol === port.protocol,
            ),
        )
        .map((port) => [`${port.hostPort}/${port.protocol}`, port]),
    ).values(),
  ]
  const pending = rules.some((rule) => !isApplied(rule)) && Boolean(live?.containers.length)

  const save = useMutation({
    mutationFn: (ports: PublishedPortRule[]) =>
      api.projects.ports(project.id, environment.id, { ports }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', updated.slug], updated)
      toast.success('Ports enregistrés : appliqués au prochain déploiement')
    },
    onError: (error) => toast.error(error.message),
  })
  const host = window.location.hostname
  // Un seul port ouvert et une adresse de site : c'est forcément elle qui y mène.
  const exposed = [
    ...rules.map((rule) => ({
      published: rule.published,
      protocol: rule.protocol,
      service: rule.service,
      target: rule.target,
    })),
    ...fromCompose.map((port) => ({
      published: port.hostPort,
      protocol: port.protocol,
      service: port.service,
      target: port.containerPort,
    })),
  ]
  const siteRoute = project.url && exposed.length === 1 ? exposed[0]! : null

  return (
    <div className="space-y-2 text-sm">
      {siteRoute && project.url && (
        <div className="bg-muted/40 space-y-1 rounded-md border p-2.5">
          <p className="flex flex-wrap items-center gap-1.5">
            <a
              href={project.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium hover:underline"
            >
              <ExternalLink className="size-3.5" />
              {hostOf(project.url)}
            </a>
            <ArrowRight className="text-muted-foreground size-3" />
            <span className="font-mono">port {portLabel(siteRoute)}</span>
            <ArrowRight className="text-muted-foreground size-3" />
            <span className="font-mono">
              {siteRoute.service}:{siteRoute.target}
            </span>
          </p>
          <p className="text-muted-foreground text-xs">
            Votre reverse proxy doit renvoyer {hostOf(project.url)} vers le port{' '}
            {siteRoute.published} de ce serveur.
          </p>
        </div>
      )}
      {rules.length === 0 && fromCompose.length === 0 && (
        <p className="text-muted-foreground text-xs">Aucun port ouvert vers l’extérieur.</p>
      )}
      {rules.map((rule) => (
        <div key={portLabel(rule)} className="flex items-center gap-2">
          <Globe className="text-success size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-mono">{portLabel(rule)}</span>{' '}
            <ArrowRight className="text-muted-foreground inline size-3" />{' '}
            <span className="font-mono">
              {rule.service}:{rule.target}
            </span>
            {withPage(rule) && (
              <Badge variant="outline" className="ml-2 font-normal">
                page d’attente
              </Badge>
            )}
            {live?.containers.length && !isApplied(rule) ? (
              <Badge variant="outline" className="text-warning ml-2">
                à déployer
              </Badge>
            ) : null}
          </span>
          {workbench.isAdmin && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={`Fermer le port ${portLabel(rule)}`}
              title="Fermer ce port (au prochain déploiement)"
              disabled={save.isPending}
              onClick={() => save.mutate(rules.filter((item) => item !== rule))}
            >
              <X />
            </Button>
          )}
        </div>
      ))}
      {fromCompose.map((port) => (
        <div
          key={`${port.hostPort}/${port.protocol}`}
          className="text-muted-foreground flex items-center gap-2"
        >
          <Globe className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="text-foreground font-mono">
              {portLabel({ published: port.hostPort, protocol: port.protocol })}
            </span>{' '}
            <ArrowRight className="inline size-3" />{' '}
            <span className="font-mono">
              {port.service}:{port.containerPort}
            </span>
            <span className="ml-2 text-xs">fichier Compose</span>
          </span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {workbench.isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            Ouvrir un port
          </Button>
        )}
        {pending && workbench.canDeploy && (
          <Button size="sm" onClick={() => workbench.openDeploy(target)}>
            <Rocket />
            Déployer pour appliquer
          </Button>
        )}
      </div>
      {rules.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Joignable sur{' '}
          <span className="font-mono">
            {host}:{rules[0]!.published}
          </span>{' '}
          si le pare-feu du serveur autorise ce port.
        </p>
      )}
      {adding && (
        <OpenPortDialog
          project={project}
          rules={rules}
          onClose={() => setAdding(false)}
          onSaved={(updated) => {
            queryClient.setQueryData(['projects', updated.slug], updated)
            setAdding(false)
          }}
          environmentId={environment.id}
          canDeploy={workbench.canDeploy && Boolean(live?.containers.length)}
          onDeploy={() => workbench.openDeploy(target)}
        />
      )}
    </div>
  )
}

function OpenPortDialog({
  project,
  environmentId,
  rules,
  onClose,
  onSaved,
  canDeploy,
  onDeploy,
}: {
  project: ProjectView
  environmentId: string
  rules: PublishedPortRule[]
  onClose: () => void
  onSaved: (project: ProjectView) => void
  canDeploy: boolean
  onDeploy: () => void
}) {
  const compose = useProjectCompose(project)
  const services = (compose.data?.analysis.services ?? []).filter((item) => !item.networkMode)
  const [service, setService] = useState('')
  const [target, setTarget] = useState('')
  const [published, setPublished] = useState('')
  const [publishedEdited, setPublishedEdited] = useState(false)
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  // Page d'attente : par défaut pour un site ou une API, pas pour une base de données.
  const [page, setPage] = useState(true)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  const chooseService = (name: string) => {
    setService(name)
    const info = services.find((item) => item.name === name)
    // Port déjà déclaré par le service (`3700:3700`, `expose`), sinon celui de son image.
    const declared = info?.ports[0]?.split(':').at(-1)?.split('/')[0]
    const guess = declared ?? defaultPort(info?.image)?.toString() ?? ''
    setPage(!DATABASE_PORTS.has(Number(guess)))
    if (guess) {
      setTarget(guess)
      if (!publishedEdited) setPublished(guess)
    }
  }

  const save = useMutation({
    mutationFn: () =>
      api.projects.ports(project.id, environmentId, {
        ports: [
          ...rules,
          {
            service,
            published: Number(published),
            target: Number(target),
            protocol,
            page: protocol === 'tcp' && page,
          },
        ],
      }),
    onSuccess: (updated) => {
      toast.success(`Port ${published} ouvert vers ${service}:${target}`, {
        description: 'Appliqué au prochain déploiement.',
        ...(canDeploy ? { action: { label: 'Déployer', onClick: onDeploy } } : {}),
      })
      onSaved(updated)
    },
    onError: (failure) =>
      setError({
        message: failure.message,
        field: failure instanceof ApiError ? failure.field : undefined,
      }),
  })
  const valid =
    service && /^\d+$/.test(target) && /^\d+$/.test(published) && Number(published) <= 65535

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ouvrir un port</DialogTitle>
          <DialogDescription>
            Le port du serveur est ouvert à tous (toutes les interfaces) et renvoie vers le port du
            conteneur. Appliqué au prochain déploiement.
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
          <div className="space-y-1.5">
            <Label htmlFor="port-service">Service</Label>
            <Select value={service} onValueChange={chooseService} disabled={!services.length}>
              <SelectTrigger
                id="port-service"
                className="w-full"
                aria-invalid={error?.field === 'service'}
              >
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
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="port-published">Port du serveur</Label>
              <Input
                id="port-published"
                inputMode="numeric"
                className="font-mono"
                placeholder="8080"
                value={published}
                aria-invalid={error?.field === 'published'}
                onChange={(event) => {
                  setPublished(event.target.value.replace(/\D/g, ''))
                  setPublishedEdited(true)
                }}
              />
            </div>
            <ArrowRight className="text-muted-foreground mb-2.5 size-4" />
            <div className="space-y-1.5">
              <Label htmlFor="port-target">Port du conteneur</Label>
              <Input
                id="port-target"
                inputMode="numeric"
                className="font-mono"
                placeholder="80"
                value={target}
                onChange={(event) => {
                  const value = event.target.value.replace(/\D/g, '')
                  setTarget(value)
                  if (!publishedEdited) setPublished(value)
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="port-protocol">Protocole</Label>
            <Select value={protocol} onValueChange={(value) => setProtocol(value as 'tcp' | 'udp')}>
              <SelectTrigger id="port-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP (web, API, base de données…)</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {protocol === 'tcp' && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={page}
                onCheckedChange={(checked) => setPage(checked === true)}
              />
              <span>
                Page « site indisponible » pendant un redémarrage
                <span className="text-muted-foreground block text-xs">
                  Au lieu d’une erreur 502. Pour un site ou une API (HTTP) ; décochez pour une base
                  de données ou tout autre protocole.
                </span>
              </span>
            </label>
          )}
          {valid && (
            <p className="bg-muted/50 rounded-md p-2 text-sm">
              <span className="font-mono">
                {window.location.hostname}:{published}
              </span>{' '}
              <ArrowRight className="inline size-3.5" />{' '}
              <span className="font-mono">
                {service}:{target}
              </span>
            </p>
          )}
          {error && <p className="text-destructive text-sm">{error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Ouvrir le port
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
