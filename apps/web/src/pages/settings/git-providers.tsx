import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, GitBranch, Loader2, Plus, PlugZap } from 'lucide-react'
import { toast } from 'sonner'
import {
  defaultImageRegistry,
  type GitProviderInput,
  type GitProviderType,
  type GitProviderView,
} from '@vercio/shared'
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
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { ConnectionResult } from './connection-result'
import { Field } from './form-fields'
import { EmptyState, ResourceCard } from './resource-list'

export const gitProvidersKey = ['settings', 'git-providers'] as const

export const PROVIDER_LABELS: Record<GitProviderType, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
}

const PROVIDER_DEFAULTS: Record<
  GitProviderType,
  { name: string; url: string; urlHint: string; tokenPlaceholder: string; help: string }
> = {
  gitlab: {
    name: 'GitLab',
    url: 'https://gitlab.com',
    urlHint: 'https://gitlab.com ou l’adresse de votre GitLab (sans /api/v4)',
    tokenPlaceholder: 'glpat-…',
    help: 'GitLab.com ou un GitLab auto-hébergé. Vercio n’y fait que lire : un token en lecture suffit.',
  },
  github: {
    name: 'GitHub',
    url: 'https://github.com',
    urlHint: 'https://github.com ou l’adresse de votre GitHub Enterprise Server',
    tokenPlaceholder: 'github_pat_… ou ghp_…',
    help: 'GitHub.com ou GitHub Enterprise Server. Vercio n’y fait que lire : un token en lecture suffit.',
  },
}

export function GitProvidersTab() {
  const providers = useQuery({ queryKey: gitProvidersKey, queryFn: api.gitProviders.list })
  const [editing, setEditing] = useState<GitProviderView | 'new' | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          GitLab (GitLab.com ou auto-hébergé) et GitHub (GitHub.com ou Enterprise Server) : Vercio y
          lit les branches, les tags et les fichiers Compose, et, avec le même token, les images que
          votre CI pousse dans leur registry. Un token en lecture seule suffit.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          Ajouter GitLab ou GitHub
        </Button>
      </div>

      {providers.isPending && <Skeleton className="h-36 w-full" />}
      {providers.error && <p className="text-destructive text-sm">{providers.error.message}</p>}
      {providers.data?.length === 0 && (
        <EmptyState icon={<GitBranch />} title="Aucun fournisseur Git">
          Ajoutez votre GitLab ou votre GitHub pour créer des projets à partir de vos dépôts.
        </EmptyState>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {providers.data?.map((provider) => (
          <ResourceCard
            key={provider.id}
            item={provider}
            queryKey={gitProvidersKey}
            icon={<GitBranch />}
            test={api.gitProviders.test}
            remove={api.gitProviders.remove}
            onEdit={() => setEditing(provider)}
            meta={
              <>
                <span>{PROVIDER_LABELS[provider.type]}</span>
                <span>Token {provider.tokenHint}</span>
                {provider.caCertificate && <span>Autorité interne</span>}
                <span>{provider.usedBy > 0 ? `${provider.usedBy} source(s)` : 'Non utilisé'}</span>
                {provider.registries.length > 0 ? (
                  <span>Images : {provider.registries.map((item) => item.url).join(', ')}</span>
                ) : (
                  <AddRegistryButton provider={provider} />
                )}
              </>
            }
          />
        ))}
      </div>

      {editing && (
        <GitProviderDialog
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/** Fournisseur enregistré sans registry : on l'ajoute en un clic, sur le même token. */
function AddRegistryButton({ provider }: { provider: GitProviderView }) {
  const queryClient = useQueryClient()
  const add = useMutation({
    mutationFn: () =>
      api.gitProviders.addRegistry(provider.id, defaultImageRegistry(provider.type, provider.url)),
    onSuccess: async () => {
      toast.success('Registry d’images ajouté')
      await queryClient.invalidateQueries({ queryKey: gitProvidersKey })
      await queryClient.invalidateQueries({ queryKey: ['settings', 'registries'] })
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'registries'] })
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <button
      type="button"
      className="text-primary underline-offset-4 hover:underline"
      onClick={() => add.mutate()}
      disabled={add.isPending}
    >
      Lire aussi les images ({defaultImageRegistry(provider.type, provider.url)})
    </button>
  )
}

function GitProviderDialog({
  provider,
  onClose,
}: {
  provider: GitProviderView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<GitProviderType>(provider?.type ?? 'gitlab')
  const [name, setName] = useState(provider?.name ?? PROVIDER_DEFAULTS.gitlab.name)
  const [url, setUrl] = useState(provider?.url ?? PROVIDER_DEFAULTS.gitlab.url)
  const defaults = PROVIDER_DEFAULTS[type]

  function onTypeChange(next: GitProviderType) {
    // Remplace les valeurs par défaut de l'autre type, sans écraser une saisie.
    if (name === PROVIDER_DEFAULTS[type].name) setName(PROVIDER_DEFAULTS[next].name)
    if (url === PROVIDER_DEFAULTS[type].url) setUrl(PROVIDER_DEFAULTS[next].url)
    setType(next)
  }
  const [token, setToken] = useState('')
  // Création : registry d'images de la même instance, sur le même token.
  const [withRegistry, setWithRegistry] = useState(true)
  const [registryUrl, setRegistryUrl] = useState<string | null>(null)
  const effectiveRegistryUrl = registryUrl ?? defaultImageRegistry(type, url)
  const [caCertificate, setCaCertificate] = useState(provider?.caCertificate ?? '')
  const [showAdvanced, setShowAdvanced] = useState(Boolean(provider?.caCertificate))

  const input = (): GitProviderInput => ({
    name,
    type,
    url,
    token: token || undefined,
    caCertificate: caCertificate || undefined,
    ...(provider ? {} : { imageRegistry: withRegistry ? { url: effectiveRegistryUrl } : null }),
  })

  const test = useMutation({
    mutationFn: () => api.gitProviders.testDraft({ ...input(), id: provider?.id }),
  })
  const save = useMutation({
    mutationFn: () =>
      provider ? api.gitProviders.update(provider.id, input()) : api.gitProviders.create(input()),
    onSuccess: async (saved) => {
      toast.success(`« ${saved.name} » enregistré`)
      await queryClient.invalidateQueries({ queryKey: gitProvidersKey })
      onClose()
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field === field ? save.error.message : null

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
              {provider ? `Modifier « ${provider.name} »` : 'Ajouter GitLab ou GitHub'}
            </DialogTitle>
            <DialogDescription>{defaults.help}</DialogDescription>
          </DialogHeader>

          {!provider && (
            <Field id="gp-type" label="Fournisseur">
              <Select
                value={type}
                onValueChange={(value) => onTypeChange(value as GitProviderType)}
              >
                <SelectTrigger id="gp-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gitlab">GitLab (GitLab.com ou auto-hébergé)</SelectItem>
                  <SelectItem value="github">GitHub (GitHub.com ou Enterprise Server)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field id="gp-name" label="Nom" error={fieldError('name')}>
            <Input id="gp-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field
            id="gp-url"
            label="URL de l’instance"
            hint={defaults.urlHint}
            error={fieldError('url')}
          >
            <Input
              id="gp-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </Field>
          <Field
            id="gp-token"
            label="Token d’accès"
            hint={
              provider
                ? `Laissez vide pour conserver le token actuel (${provider.tokenHint})`
                : undefined
            }
            error={fieldError('token')}
          >
            <Input
              id="gp-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={defaults.tokenPlaceholder}
              required={!provider}
            />
          </Field>
          <TokenRights type={type} url={url} />

          {!provider && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor="gp-registry">Lire aussi les images construites par la CI</Label>
                  <p className="text-muted-foreground text-xs">
                    Vercio lit les versions des images dans le registry de {PROVIDER_LABELS[type]}{' '}
                    avec ce même token : rien d’autre à configurer.
                  </p>
                </div>
                <Switch id="gp-registry" checked={withRegistry} onCheckedChange={setWithRegistry} />
              </div>
              {withRegistry && (
                <Field
                  id="gp-registry-url"
                  label="Adresse du registry"
                  hint={
                    type === 'gitlab'
                      ? 'Visible dans GitLab : Déployer → Registre de conteneurs.'
                      : 'ghcr.io pour GitHub.com.'
                  }
                >
                  <Input
                    id="gp-registry-url"
                    className="font-mono text-sm"
                    value={effectiveRegistryUrl}
                    onChange={(e) => setRegistryUrl(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}

          {showAdvanced ? (
            <Field
              id="gp-ca"
              label="Certificat de l’autorité interne (PEM)"
              hint="Uniquement si votre instance utilise un certificat signé par une autorité interne. Laissez vide pour le retirer."
              error={fieldError('caCertificate')}
            >
              <Textarea
                id="gp-ca"
                rows={4}
                className="font-mono text-xs"
                value={caCertificate}
                onChange={(e) => setCaCertificate(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----"
              />
            </Field>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
              onClick={() => setShowAdvanced(true)}
            >
              Certificat d’autorité interne…
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

/** Instance GitHub / GitLab saisie, sans barre finale (liens de création de token). */
function instanceUrl(url: string, fallback: string): string {
  try {
    return new URL(url).origin
  } catch {
    return fallback
  }
}

/** Droits du token à créer, avec un lien vers la page de création, droits pré-remplis. */
function TokenRights({ type, url }: { type: GitProviderType; url: string }) {
  const link =
    'text-primary inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline'
  if (type === 'gitlab') {
    const base = instanceUrl(url, 'https://gitlab.com')
    return (
      <div className="bg-muted/40 space-y-2 rounded-lg border p-3 text-xs">
        <p className="font-medium">Droits nécessaires</p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-4">
          <li>
            <code>read_api</code> : branches, tags, commits et fichier Compose.
          </li>
          <li>
            <code>read_registry</code> : images du registry GitLab (si vous l’utilisez).
          </li>
          <li>
            Pour que Vercio crée lui-même les webhooks : <code>api</code> à la place de{' '}
            <code>read_api</code>, et le rôle <em>Maintainer</em>.
          </li>
          <li>
            Token de groupe ou de projet : rôle <em>Reporter</em> au minimum.
          </li>
        </ul>
        <a
          className={link}
          href={`${base}/-/user_settings/personal_access_tokens?name=Vercio&scopes=read_api,read_registry`}
          target="_blank"
          rel="noreferrer"
        >
          Créer un token personnel sur GitLab
          <ExternalLink className="size-3" />
        </a>
      </div>
    )
  }
  const base = instanceUrl(url, 'https://github.com')
  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border p-3 text-xs">
      <p className="font-medium">Droits nécessaires</p>
      <div className="text-muted-foreground space-y-1">
        <p>
          <span className="text-foreground">Token classique</span> (nécessaire pour les images GHCR)
          : <code>repo</code> et <code>read:packages</code> ; ajoutez <code>admin:repo_hook</code>{' '}
          pour que Vercio crée lui-même les webhooks.
        </p>
        <a
          className={link}
          href={`${base}/settings/tokens/new?scopes=repo,read:packages&description=Vercio`}
          target="_blank"
          rel="noreferrer"
        >
          Créer un token classique
          <ExternalLink className="size-3" />
        </a>
      </div>
      <div className="text-muted-foreground space-y-1">
        <p>
          <span className="text-foreground">Token fine-grained</span> (lecture seule, sans GHCR) :
          accès aux dépôts concernés, <em>Contents</em> et <em>Metadata</em> en <em>Read-only</em>.
        </p>
        <a
          className={link}
          href={`${base}/settings/personal-access-tokens/new`}
          target="_blank"
          rel="noreferrer"
        >
          Créer un token fine-grained
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}
