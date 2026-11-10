import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, FlaskConical, KeyRound, Loader2, Lock, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { SSO_DEFAULTS, type SsoSettingsInput, type SsoSettingsView } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, ApiError } from '@/lib/api'
import { ConnectionResult } from './connection-result'
import { Field } from './form-fields'

const QUERY_KEY = ['settings', 'sso']

function formFrom(view: SsoSettingsView): SsoSettingsInput {
  return {
    enabled: view.source === 'none' ? true : view.enabled,
    issuer: view.issuer,
    clientId: view.clientId,
    clientSecret: '',
    providerName: view.providerName,
    scopes: view.scopes,
    rolesClaims: view.rolesClaims,
  }
}

/** Paramètres → Connexion : SSO OpenID Connect (Keycloak…), appliqué sans redémarrage. */
export function SsoSettingsTab() {
  const view = useQuery({ queryKey: QUERY_KEY, queryFn: api.sso.get })
  if (view.isPending) return <Skeleton className="h-96 w-full" />
  if (view.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{view.error.message}</AlertDescription>
      </Alert>
    )
  }
  // Formulaire réinitialisé quand la configuration enregistrée change (secret vidé, etc.).
  return <SsoForm key={JSON.stringify(view.data)} view={view.data} />
}

function SsoForm({ view }: { view: SsoSettingsView }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => formFrom(view))
  const readOnly = view.source === 'env'

  const set = <K extends keyof SsoSettingsInput>(key: K, value: SsoSettingsInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const test = useMutation({ mutationFn: () => api.sso.test(form) })
  const save = useMutation({
    mutationFn: () => api.sso.save(form),
    onSuccess: (saved) => {
      queryClient.setQueryData(QUERY_KEY, saved)
      void queryClient.invalidateQueries({ queryKey: ['auth', 'config'] })
      toast.success(saved.enabled ? 'SSO activé' : 'SSO enregistré, désactivé')
    },
  })
  const remove = useMutation({
    mutationFn: api.sso.remove,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success('Configuration SSO supprimée')
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field === field ? save.error.message : null
  const secretMissing = !view.hasSecret && !form.clientSecret

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <KeyRound className="size-5" />
            Connexion SSO
            <StateBadge view={view} />
          </CardTitle>
          <CardDescription>
            Connexion avec Keycloak ou tout fournisseur OpenID Connect. Appliqué tout de suite, sans
            redémarrer Vercio.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {readOnly && (
            <Alert className="mb-4">
              <Lock />
              <AlertDescription>
                Défini dans le fichier .env (variables <code>OIDC_*</code>) : ces valeurs priment et
                ne se modifient que là. Retirez-les du .env pour gérer le SSO ici.
              </AlertDescription>
            </Alert>
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <fieldset disabled={readOnly} className="space-y-4">
              <Field
                id="sso-issuer"
                label="Adresse du realm"
                hint="Celle du realm, pas de la console : https://keycloak.exemple.fr/realms/mon-realm"
                error={fieldError('issuer')}
              >
                <Input
                  id="sso-issuer"
                  placeholder="https://keycloak.exemple.fr/realms/mon-realm"
                  value={form.issuer}
                  onChange={(event) => set('issuer', event.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="sso-client" label="Client ID" error={fieldError('clientId')}>
                  <Input
                    id="sso-client"
                    value={form.clientId}
                    onChange={(event) => set('clientId', event.target.value)}
                  />
                </Field>
                <Field
                  id="sso-secret"
                  label="Secret du client"
                  hint={
                    view.hasSecret && !readOnly
                      ? 'Enregistré : laissez vide pour le conserver'
                      : 'Onglet « Credentials » du client dans Keycloak'
                  }
                  error={fieldError('clientSecret')}
                >
                  <Input
                    id="sso-secret"
                    type="password"
                    autoComplete="new-password"
                    placeholder={view.hasSecret ? '••••••••••••' : ''}
                    value={form.clientSecret}
                    onChange={(event) => set('clientSecret', event.target.value)}
                  />
                </Field>
              </div>
              <Field
                id="sso-name"
                label="Nom affiché sur le bouton"
                hint={`« Se connecter avec ${form.providerName || '…'} »`}
                error={fieldError('providerName')}
              >
                <Input
                  id="sso-name"
                  maxLength={40}
                  value={form.providerName}
                  onChange={(event) => set('providerName', event.target.value)}
                />
              </Field>
              <details className="group rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">Réglages avancés</summary>
                <div className="mt-3 space-y-4">
                  <Field
                    id="sso-scopes"
                    label="Scopes"
                    hint={`Par défaut : ${SSO_DEFAULTS.scopes}`}
                  >
                    <Input
                      id="sso-scopes"
                      className="font-mono text-xs"
                      value={form.scopes}
                      onChange={(event) => set('scopes', event.target.value)}
                    />
                  </Field>
                  <Field
                    id="sso-roles"
                    label="Où lire les rôles"
                    hint="Chemins séparés par des virgules ; {clientId} est remplacé par le Client ID. Par défaut : rôles du client, du realm, et groupes à la racine."
                  >
                    <Input
                      id="sso-roles"
                      className="font-mono text-xs"
                      value={form.rolesClaims}
                      onChange={(event) => set('rolesClaims', event.target.value)}
                    />
                  </Field>
                </div>
              </details>
              <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block text-sm font-medium">Bouton de connexion SSO</span>
                  <span className="text-muted-foreground block text-xs">
                    Désactivé : le bouton disparaît et les sessions SSO ouvertes sont fermées.
                  </span>
                </span>
                <Switch checked={form.enabled} onCheckedChange={(value) => set('enabled', value)} />
              </label>
            </fieldset>

            {test.data && <ConnectionResult check={test.data} />}
            {test.error && (
              <Alert variant="destructive">
                <AlertDescription>{test.error.message}</AlertDescription>
              </Alert>
            )}
            {save.error && !fieldError('issuer') && !fieldError('clientId') && (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}

            {!readOnly && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={test.isPending || !form.issuer || !form.clientId || secretMissing}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                  Tester
                </Button>
                <Button
                  type="submit"
                  disabled={save.isPending || !form.issuer || !form.clientId || secretMissing}
                >
                  {save.isPending && <Loader2 className="animate-spin" />}
                  Enregistrer
                </Button>
                {view.source === 'settings' && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:text-destructive ml-auto"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 />
                    Supprimer
                  </Button>
                )}
              </div>
            )}
            {remove.error && (
              <Alert variant="destructive">
                <AlertDescription>{remove.error.message}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Dans Keycloak</CardTitle>
          <CardDescription>
            Créez un client OpenID Connect avec « Client authentication » activé et le flux
            standard, puis renseignez ces adresses.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField label="Valid redirect URIs" value={view.redirectUri} />
          <CopyField label="Valid post logout redirect URIs" value={view.postLogoutRedirectUri} />
          <CopyField label="Backchannel logout URL" value={view.backchannelLogoutUri} />
          <div className="text-muted-foreground space-y-1 border-t pt-3 text-xs">
            <p>
              Rôles à créer (rôles du client, du realm, ou groupes à la racine) :{' '}
              <code>vercio-admin</code>, <code>vercio-deployer</code>, <code>vercio-viewer</code>.
            </p>
            {view.localAuth && (
              <p>
                Les comptes locaux restent actifs : ils permettent de se connecter si le fournisseur
                est en panne ou mal configuré.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function StateBadge({ view }: { view: SsoSettingsView }) {
  if (view.source === 'none') return <Badge variant="outline">Non configuré</Badge>
  if (!view.enabled) return <Badge variant="outline">Désactivé</Badge>
  return (
    <Badge variant="outline" className="border-success/40 text-success">
      Actif{view.source === 'env' ? ' (.env)' : ''}
    </Badge>
  )
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex items-center gap-1">
        <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" title={value}>
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Copier ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
