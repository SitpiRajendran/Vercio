import { useState } from 'react'
import { Box, ExternalLink, TriangleAlert } from 'lucide-react'
import { parseImageReference, type ComposeServiceInfo } from '@vercio/shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CatalogRegistry } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface SourceDraft {
  /** Identifiant en base pour une source existante, clé locale sinon. */
  key: string
  name: string
  gitProviderId: string
  repository: string
  defaultBranch: string
}

export interface ServiceDraft {
  serviceName: string
  image: string | null
  tracked: boolean
  sourceKey: string
  registryId: string
  imageRepository: string
}

const registryHost = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')

/**
 * Propose un suivi pour chaque service dont l'image vient d'un registry configuré :
 * `registry.gitlab.com/acme/site/front:latest` → registry GitLab, chemin `acme/site/front`.
 */
export function autoMapServices(
  services: ComposeServiceInfo[],
  registries: CatalogRegistry[],
  sources: SourceDraft[],
  previous: ServiceDraft[] = [],
): ServiceDraft[] {
  return services.map((service) => {
    const kept = previous.find((draft) => draft.serviceName === service.name)
    if (kept) return { ...kept, image: service.image }
    const reference = service.image ? parseImageReference(service.image) : null
    const registry = reference?.host
      ? registries.find((item) => registryHost(item.url) === reference.host)
      : undefined
    return {
      serviceName: service.name,
      image: service.image,
      tracked: Boolean(registry),
      sourceKey: sources[0]?.key ?? '',
      registryId: registry?.id ?? registries[0]?.id ?? '',
      imageRepository: registry && reference ? reference.path : '',
    }
  })
}

/**
 * Pour chaque service : version fixe (l'image du fichier Compose) ou version suivie (les
 * images construites par la CI, lues dans le registry de GitLab ou GitHub).
 */
export function ServicesMapping({
  services,
  onChange,
  sources,
  registries,
  imageSuggestions = [],
}: {
  services: ServiceDraft[]
  onChange: (services: ServiceDraft[]) => void
  sources: SourceDraft[]
  registries: CatalogRegistry[]
  imageSuggestions?: string[]
}) {
  const update = (index: number, patch: Partial<ServiceDraft>) =>
    onChange(services.map((service, i) => (i === index ? { ...service, ...patch } : service)))

  return (
    <div className="divide-y rounded-lg border">
      <datalist id="image-suggestions">
        {imageSuggestions.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      {services.map((service, index) => (
        <ServiceRow
          key={service.serviceName}
          service={service}
          onChange={(patch) => update(index, patch)}
          sources={sources}
          registries={registries}
        />
      ))}
      {registries.length === 0 && (
        <Alert className="rounded-none border-0 border-t">
          <TriangleAlert />
          <AlertTitle>Images de la CI indisponibles</AlertTitle>
          <AlertDescription>
            <p>
              Pour suivre les versions construites par votre CI, Vercio lit les images dans le
              registry de GitLab ou GitHub. Activez « Lire aussi les images » sur votre connexion
              GitLab ou GitHub (Paramètres → Code et images) ; cette page se met à jour toute seule
              ensuite. En attendant, les images restent celles écrites dans le fichier Compose.
            </p>
            <a
              href="/parametres#code"
              target="_blank"
              rel="noreferrer"
              className="text-primary inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
            >
              Ouvrir Code et images
              <ExternalLink className="size-3" />
            </a>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function ServiceRow({
  service,
  onChange,
  sources,
  registries,
}: {
  service: ServiceDraft
  onChange: (patch: Partial<ServiceDraft>) => void
  sources: SourceDraft[]
  registries: CatalogRegistry[]
}) {
  const registry = registries.find((item) => item.id === service.registryId)
  const source = sources.find((item) => item.key === service.sourceKey)
  const complete = Boolean(registry && source && service.imageRepository)
  const [editing, setEditing] = useState(!complete)
  const showFields = service.tracked && (editing || !complete)

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Box className="text-muted-foreground size-4" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{service.serviceName}</p>
          <p className="text-muted-foreground truncate font-mono text-xs">
            {service.image ?? 'aucune image'}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={`Version de ${service.serviceName}`}
          className="bg-muted inline-flex rounded-md p-0.5"
        >
          {[
            { tracked: false, label: 'Version fixe' },
            { tracked: true, label: 'Suivre la CI' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={service.tracked === option.tracked}
              disabled={option.tracked && registries.length === 0}
              onClick={() => onChange({ tracked: option.tracked })}
              className={cn(
                'rounded px-2.5 py-1 text-xs disabled:opacity-50',
                service.tracked === option.tracked
                  ? 'bg-background shadow-xs'
                  : 'text-muted-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground pl-7 text-xs">
        {!service.tracked ? (
          'Image du fichier Compose, téléchargée à nouveau à chaque mise à jour (redis, postgres…).'
        ) : complete && !editing ? (
          <>
            Versions construites par la CI de{' '}
            <span className="text-foreground">{source!.repository}</span>, lues dans{' '}
            <span className="text-foreground font-mono">
              {registryHost(registry!.url)}/{service.imageRepository}
            </span>
            .{' '}
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={() => setEditing(true)}
            >
              Modifier
            </button>
          </>
        ) : (
          'Indiquez le dépôt dont la CI construit l’image, et où elle la range.'
        )}
      </p>

      {showFields && (
        <div className="grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">Dépôt de code</Label>
            <Select
              value={service.sourceKey}
              onValueChange={(sourceKey) => onChange({ sourceKey })}
            >
              <SelectTrigger className="w-full" aria-label={`Dépôt de ${service.serviceName}`}>
                <SelectValue placeholder="Choisir un dépôt" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.repository}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">Registry d’images</Label>
            <Select
              value={service.registryId}
              onValueChange={(registryId) => onChange({ registryId })}
            >
              <SelectTrigger className="w-full" aria-label={`Registry de ${service.serviceName}`}>
                <SelectValue placeholder="Registry" />
              </SelectTrigger>
              <SelectContent>
                {registries.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label
              htmlFor={`image-${service.serviceName}`}
              className="text-muted-foreground text-xs"
            >
              Chemin de l’image dans le registry
            </Label>
            <Input
              id={`image-${service.serviceName}`}
              list="image-suggestions"
              className="font-mono text-xs"
              placeholder="groupe/projet/service"
              value={service.imageRepository}
              onChange={(event) => onChange({ imageRepository: event.target.value.trim() })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Erreur bloquante du mapping, ou null. */
export function mappingError(services: ServiceDraft[], sources: SourceDraft[]): string | null {
  for (const service of services.filter((item) => item.tracked)) {
    if (!sources.some((source) => source.key === service.sourceKey)) {
      return `Choisissez le dépôt Git qui construit « ${service.serviceName} ».`
    }
    if (!service.registryId) return `Choisissez le registry de « ${service.serviceName} ».`
    if (!service.imageRepository)
      return `Indiquez le chemin de l’image de « ${service.serviceName} ».`
  }
  return null
}
