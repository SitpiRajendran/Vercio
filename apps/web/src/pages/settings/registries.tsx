import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Container, Loader2, Plus, PlugZap } from 'lucide-react'
import { toast } from 'sonner'
import { REGISTRY_PROVIDER_TYPE, type RegistryInput, type RegistryView } from '@vercio/shared'
import { Button } from '@/components/ui/button'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { ConnectionResult } from './connection-result'
import { Field } from './form-fields'
import { gitProvidersKey } from './git-providers'
import { EmptyState, ResourceCard } from './resource-list'

export const registriesKey = ['settings', 'registries'] as const

const TYPE_LABELS: Record<RegistryView['type'], string> = {
  gitlab: 'Registry GitLab',
  oci: 'Registry privé',
  ghcr: 'GitHub (GHCR)',
}

export function RegistriesTab() {
  const registries = useQuery({ queryKey: registriesKey, queryFn: api.registries.list })
  const [editing, setEditing] = useState<RegistryView | 'new' | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Ceux de GitLab et GitHub sont ajoutés avec leur connexion, sur le même token. Ajoutez ici
          un autre registry privé (Docker Hub, Harbor, Nexus, registry:2…).
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          Ajouter un registry
        </Button>
      </div>

      {registries.isPending && <Skeleton className="h-36 w-full" />}
      {registries.error && <p className="text-destructive text-sm">{registries.error.message}</p>}
      {registries.data?.length === 0 && (
        <EmptyState icon={<Container />} title="Aucun registry">
          Rien à faire si vos images sont sur GitLab ou GitHub : leur registry s’ajoute avec la
          connexion.
        </EmptyState>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {registries.data?.map((registry) => (
          <ResourceCard
            key={registry.id}
            item={registry}
            queryKey={registriesKey}
            icon={<Container />}
            test={api.registries.test}
            remove={api.registries.remove}
            onEdit={() => setEditing(registry)}
            meta={
              <>
                <span>{TYPE_LABELS[registry.type]}</span>
                <span>
                  {registry.username
                    ? `Compte ${registry.username}`
                    : registry.gitProviderId
                      ? 'Même token que la connexion Git'
                      : registry.hasPassword
                        ? 'Authentifié'
                        : 'Anonyme'}
                </span>
                {registry.insecure && <span className="text-warning">HTTP non chiffré</span>}
                {registry.caCertificate && <span>Autorité interne</span>}
                <span>{registry.usedBy > 0 ? `${registry.usedBy} service(s)` : 'Non utilisé'}</span>
              </>
            }
          />
        ))}
      </div>

      {editing && (
        <RegistryDialog
          registry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const NO_PROVIDER = 'none'

/** Identifiants à fournir, par type de registry : la lecture (pull) suffit toujours. */
const REGISTRY_TOKEN_HINTS: Record<RegistryType, string> = {
  ghcr: 'token GitHub classique avec read:packages',
  gitlab: 'deploy token ou token avec read_registry',
  oci: 'compte ou robot avec le droit de pull (Harbor, Nexus, Docker Hub : token « Read-only »)',
}
type RegistryType = RegistryView['type']
const REGISTRY_DEFAULT_URL: Partial<Record<RegistryType, string>> = {
  gitlab: 'registry.gitlab.com',
  ghcr: 'ghcr.io',
}

function RegistryDialog({
  registry,
  onClose,
}: {
  registry: RegistryView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const providers = useQuery({ queryKey: gitProvidersKey, queryFn: api.gitProviders.list })
  const [type, setType] = useState<RegistryType>(registry?.type ?? 'oci')
  const [name, setName] = useState(registry?.name ?? '')
  const [url, setUrl] = useState(registry?.url ?? '')
  const [username, setUsername] = useState(registry?.username ?? '')
  const [password, setPassword] = useState('')
  const [gitProviderId, setGitProviderId] = useState(registry?.gitProviderId ?? NO_PROVIDER)
  const [insecure, setInsecure] = useState(registry?.insecure ?? false)
  const [caCertificate, setCaCertificate] = useState(registry?.caCertificate ?? '')
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(registry?.caCertificate || registry?.insecure),
  )

  const providerType = REGISTRY_PROVIDER_TYPE[type]
  const compatibleProviders = providers.data?.filter((p) => p.type === providerType) ?? []
  const linkedProvider = Boolean(providerType) && gitProviderId !== NO_PROVIDER

  const input = (): RegistryInput => ({
    name,
    type,
    url,
    username: username || undefined,
    password: password || undefined,
    gitProviderId: linkedProvider ? gitProviderId : null,
    insecure,
    caCertificate: caCertificate || undefined,
  })

  const test = useMutation({
    mutationFn: () => api.registries.testDraft({ ...input(), id: registry?.id }),
  })
  const save = useMutation({
    mutationFn: () =>
      registry ? api.registries.update(registry.id, input()) : api.registries.create(input()),
    onSuccess: async (saved) => {
      toast.success(`« ${saved.name} » enregistré`)
      await queryClient.invalidateQueries({ queryKey: registriesKey })
      onClose()
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field === field ? save.error.message : null

  function onTypeChange(value: RegistryType) {
    setType(value)
    const knownUrls = Object.values(REGISTRY_DEFAULT_URL)
    if (!url || knownUrls.includes(url)) setUrl(REGISTRY_DEFAULT_URL[value] ?? '')
    // Propose le premier fournisseur compatible pour réutiliser son token.
    const compatible = providers.data?.find((p) => p.type === REGISTRY_PROVIDER_TYPE[value])
    setGitProviderId(compatible?.id ?? NO_PROVIDER)
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {registry ? `Modifier « ${registry.name} »` : 'Ajouter un registry'}
            </DialogTitle>
            <DialogDescription>
              Un compte en lecture seule (pull) suffit : Vercio ne pousse jamais d’image.
            </DialogDescription>
          </DialogHeader>

          <Field id="rg-type" label="Type">
            <Select value={type} onValueChange={(value) => onTypeChange(value as RegistryType)}>
              <SelectTrigger id="rg-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="oci">
                  Registry privé (registry:2, Harbor, Nexus, Docker Hub…)
                </SelectItem>
                <SelectItem value="gitlab">Registry GitLab</SelectItem>
                <SelectItem value="ghcr">GitHub Container Registry (ghcr.io)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="rg-name" label="Nom" error={fieldError('name')}>
            <Input
              id="rg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 'gitlab' ? 'Registry GitLab' : 'Registry interne'}
              required
            />
          </Field>
          <Field
            id="rg-url"
            label="Adresse du registry"
            hint="Hôte et port, sans chemin : registry.gitlab.com, registry.example.com:5000"
            error={fieldError('url')}
          >
            <Input id="rg-url" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </Field>

          {providerType && (
            <Field
              id="rg-provider"
              label="Identifiants"
              hint={
                type === 'ghcr'
                  ? 'Réutilise le token du fournisseur GitHub : il doit être un token classique avec read:packages.'
                  : 'Réutilise le token du fournisseur GitLab : il doit avoir la portée read_registry.'
              }
            >
              <Select value={gitProviderId} onValueChange={setGitProviderId}>
                <SelectTrigger id="rg-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {compatibleProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      Token de « {provider.name} »
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_PROVIDER}>Identifiants dédiés (deploy token…)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          {!linkedProvider && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="rg-username" label="Identifiant" error={fieldError('username')}>
                <Input
                  id="rg-username"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field
                id="rg-password"
                label="Mot de passe ou token"
                hint={
                  <>
                    Lecture seule suffit : {REGISTRY_TOKEN_HINTS[type]}.{' '}
                    {registry?.hasPassword ? 'Vide = inchangé.' : 'Vide = accès anonyme.'}
                  </>
                }
              >
                <Input
                  id="rg-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
          )}

          {showAdvanced ? (
            <div className="space-y-4 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="rg-insecure">HTTP non chiffré</Label>
                  <p className="text-muted-foreground text-xs">
                    Pour un registry interne sans TLS. Docker doit aussi l’autoriser (
                    <code>insecure-registries</code> dans <code>daemon.json</code>).
                  </p>
                </div>
                <Switch id="rg-insecure" checked={insecure} onCheckedChange={setInsecure} />
              </div>
              <Field
                id="rg-ca"
                label="Certificat de l’autorité interne (PEM)"
                hint="Uniquement si le registry utilise un certificat signé par une autorité interne."
                error={fieldError('caCertificate')}
              >
                <Textarea
                  id="rg-ca"
                  rows={4}
                  className="font-mono text-xs"
                  value={caCertificate}
                  onChange={(e) => setCaCertificate(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----"
                />
              </Field>
            </div>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
              onClick={() => setShowAdvanced(true)}
            >
              Options avancées (HTTP, autorité interne)…
            </button>
          )}

          {test.data && <ConnectionResult check={test.data} />}
          {test.error && <p className="text-destructive text-sm">{test.error.message}</p>}
          {save.error && !(save.error instanceof ApiError && save.error.field) && (
            <p className="text-destructive text-sm">{save.error.message}</p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => test.mutate()}
              disabled={test.isPending || !url}
            >
              {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Tester la connexion
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
